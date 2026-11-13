import type { EventEnvelope, JobStatusChangedPayload, JobSubmittedPayload } from '@internpath/contracts';
import { OutboxWriter } from '@internpath/common';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { emitJobVerified } from '../events/job-verified';
import type { Tx } from '../prisma/types';
import { QueueService } from '../queue/queue.service';
import { RulesRepository } from '../rules/rules.repository';
import { evaluateJob } from '../screening/evaluate';

@Injectable()
export class EvaluationService {
  private readonly log = new Logger(EvaluationService.name);

  constructor(
    private readonly rules: RulesRepository,
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
  ) {}

  /**
   * ตรวจประกาศที่ส่งมา (E01) แล้วบันทึกผล + (ถ้าเหลือง) สร้างรายการคิว + ส่ง JobVerified ใน Transaction เดียว
   * ตัวตัดสินขัดข้อง = throw (ไม่จับ) → rollback และให้ retry/DLQ ของ libs/common ทำงาน — ห้าม APPROVE เอง
   * ห้าม log เนื้อหาประกาศ (log ได้แค่ id/ผลตัดสิน)
   */
  async handleJobSubmitted(env: EventEnvelope<'JobSubmitted', JobSubmittedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    if (await tx.evaluation.findUnique({ where: { submissionId: p.submission_id }, select: { id: true } })) return;

    const rules = await this.rules.load(tx);
    const e = evaluateJob(
      {
        content: p.content,
        hours_per_week: p.hours_per_week,
        allowance: p.allowance,
        company_flag_under_review: p.company_flag_under_review,
      },
      rules,
    );

    // createMany + skipDuplicates (ON CONFLICT DO NOTHING): Event ซ้ำที่ประมวลผลพร้อมกันไม่ทำให้ Transaction พัง
    const { count } = await tx.evaluation.createMany({
      data: [
        {
          jobId: p.job_id,
          companyId: p.company_id,
          submissionId: p.submission_id,
          submissionKind: p.submission_kind,
          submittedAt: new Date(p.submitted_at),
          content: e.content as unknown as Prisma.InputJsonValue,
          riskScore: e.risk_score,
          riskLevel: e.risk_level,
          decision: e.decision,
          negatedOnly: e.negated_only,
          matchedKeywords: e.matched_keywords as unknown as Prisma.InputJsonValue,
          reasons: e.reasons as unknown as Prisma.InputJsonValue,
          companyFlagUnderReview: p.company_flag_under_review,
          fastTrack: p.fast_track,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return;

    // รอบเก่าที่มาถึงช้ากว่ารอบใหม่ (เช่นถูก retry): เก็บผลไว้เฉยๆ ห้ามแตะรายการคิวหรือส่ง JobVerified ของรอบนี้
    // ไม่เช่นนั้นจะปิดรายการของรอบใหม่ทิ้งและส่งผลเก่าที่ Job ข้ามไป (ประกาศค้างโดยไม่มีรายการให้ Admin)
    const newer = await tx.evaluation.findFirst({
      where: { jobId: p.job_id, submittedAt: { gt: new Date(p.submitted_at) } },
      select: { id: true },
    });
    if (newer) {
      this.log.debug(`stale evaluation stored only job=${p.job_id} submission=${p.submission_id}`);
      return;
    }

    const open = await this.queue.findOpenItem(tx, p.job_id);
    if (open) {
      // ผลตรวจที่มาทีหลัง VERIFY_TIMEOUT (spec §5.8 ข้อ 2): ประกาศอยู่ PENDING_REVIEW แล้ว Job จะข้าม JobVerified เก่า
      // จึงแนบผลกับรายการเดิมให้ Admin ตัดสิน ไม่ส่ง Event — "ผลที่มาทีหลัง" = submission เดียวกับที่หมดเวลา
      // (หรือ E03 ไม่ระบุ submission และ E01 นี้ส่งก่อนหมดเวลา) ส่วน submission ใหม่ = ส่งตรวจรอบใหม่ → supersede
      const isLate =
        open.origin === 'VERIFY_TIMEOUT' &&
        (open.submissionId === p.submission_id ||
          (open.submissionId === null && new Date(p.submitted_at).getTime() <= open.createdAt.getTime()));
      if (isLate) {
        await tx.queueItem.update({ where: { id: open.id }, data: { riskLevel: e.risk_level, submissionId: p.submission_id } });
        this.log.debug(`late evaluation attached job=${p.job_id} submission=${p.submission_id} decision=${e.decision}`);
        return;
      }
      await this.queue.supersedeOpenItems(tx, p.job_id, 'SUPERSEDED', env.correlation_id);
    }

    if (e.decision === 'PENDING_REVIEW') {
      await this.queue.createItem(tx, {
        type: 'JOB_REVIEW',
        jobId: p.job_id,
        companyId: p.company_id,
        submissionId: p.submission_id,
        riskLevel: e.risk_level,
        fastTrack: p.fast_track,
        origin: 'EVALUATION',
        correlationId: env.correlation_id,
      });
    }

    await emitJobVerified(this.outbox, tx, {
      correlationId: env.correlation_id,
      payload: {
        job_id: p.job_id,
        submission_id: p.submission_id,
        decision: e.decision,
        risk_score: e.risk_score,
        risk_level: e.risk_level,
        reasons: e.reasons,
        is_appeal: false,
        decided_by: 'SYSTEM',
        decided_at: new Date().toISOString(),
      },
    });
    this.log.debug(`evaluated job=${p.job_id} submission=${p.submission_id} decision=${e.decision} level=${e.risk_level}`);
  }

  /**
   * E03: Job ตั้งประกาศเป็น PENDING_REVIEW เพราะ Fail-safe หมดเวลา (VERIFY_TIMEOUT) → สร้างรายการคิว JOB_REVIEW
   * (ถ้ายังไม่มีรายการเปิดของประกาศนั้น) E03 แบบอื่นข้ามในสไลซ์นี้
   */
  async handleJobStatusChanged(env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    if (p.to_status !== 'PENDING_REVIEW' || p.reason_code !== 'VERIFY_TIMEOUT') return;
    if (await this.queue.findOpenItem(tx, p.job_id)) return;

    // ผูกกับผลตรวจเฉพาะเมื่อ E03 ระบุ submission_id — ถ้าไม่ระบุ ห้ามเดาจากผลตรวจล่าสุด (อาจเป็นรอบเก่า
    // ทำให้ Admin เห็นเนื้อหาผิดรอบและตัดสินด้วย submission_id ที่ล้าสมัย) spec §5.8 ข้อ 3
    const evaluation = p.submission_id
      ? await tx.evaluation.findUnique({ where: { submissionId: p.submission_id } })
      : null;

    await this.queue.createItem(tx, {
      type: 'JOB_REVIEW',
      jobId: p.job_id,
      companyId: p.company_id,
      submissionId: p.submission_id ?? null,
      riskLevel: evaluation?.riskLevel ?? null,
      fastTrack: evaluation?.fastTrack ?? false,
      origin: 'VERIFY_TIMEOUT',
      correlationId: env.correlation_id,
    });
  }
}
