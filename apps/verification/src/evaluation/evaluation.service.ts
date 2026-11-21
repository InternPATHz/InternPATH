import type { EventEnvelope, JobStatusChangedPayload, JobSubmittedPayload } from '@internpath/contracts';
import { OutboxWriter } from '@internpath/common';
import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '../../generated/client';
import { normalizeText } from '../common/text';
import { emitJobVerified } from '../events/job-verified';
import type { Tx } from '../prisma/types';
import { QueueService } from '../queue/queue.service';

/** ทำข้อความทุกฟิลด์ของประกาศให้เป็นรูปมาตรฐาน (NFC, ตัดอักขระความกว้างศูนย์และ NUL) ก่อนเก็บให้ Admin อ่าน */
function cleanContent(content: JobSubmittedPayload['content']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(content)) if (typeof v === 'string') out[k] = normalizeText(v.replaceAll('\u0000', ''));
  return out;
}

/**
 * คัดกรองประกาศ (ปรับ Requirement 2026-11-21: ไม่มีการสแกนคำต้องห้ามหรือคะแนนความเสี่ยงแล้ว)
 * Job ส่ง E01 เฉพาะบริษัทที่ติดธง UNDER_REVIEW ⇒ เข้าคิว Admin เสมอ (`PENDING_REVIEW`)
 */
@Injectable()
export class EvaluationService {
  private readonly log = new Logger(EvaluationService.name);

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
  ) {}

  /**
   * E01 → เก็บสำเนาเนื้อหา + สร้างรายการคิว JOB_REVIEW + ส่ง JobVerified(PENDING_REVIEW) ใน Transaction เดียว
   * ห้าม log เนื้อหาประกาศ (log ได้แค่ id)
   */
  async handleJobSubmitted(env: EventEnvelope<'JobSubmitted', JobSubmittedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    // createMany + skipDuplicates: Event ซ้ำที่ประมวลผลพร้อมกันไม่ทำให้ Transaction พัง
    const { count } = await tx.jobSubmissionSnapshot.createMany({
      data: [
        {
          jobId: p.job_id,
          companyId: p.company_id,
          submissionId: p.submission_id,
          submissionKind: p.submission_kind,
          submittedAt: new Date(p.submitted_at),
          content: cleanContent(p.content) as unknown as Prisma.InputJsonValue,
          fastTrack: p.fast_track,
        },
      ],
      skipDuplicates: true,
    });
    if (count === 0) return;

    // รอบเก่าที่มาถึงช้ากว่ารอบใหม่ (เช่นถูก retry): เก็บไว้เฉยๆ ห้ามแตะรายการคิวหรือส่ง JobVerified ของรอบนี้
    const newer = await tx.jobSubmissionSnapshot.findFirst({
      where: { jobId: p.job_id, submittedAt: { gt: new Date(p.submitted_at) } },
      select: { id: true },
    });
    if (newer) {
      this.log.debug(`stale submission stored only job=${p.job_id} submission=${p.submission_id}`);
      return;
    }

    const open = await this.queue.findOpenItem(tx, p.job_id);
    if (open) {
      // ผลที่มาทีหลัง VERIFY_TIMEOUT: ประกาศอยู่ PENDING_REVIEW แล้ว Job จะข้าม JobVerified เก่า
      // จึงผูก submission เข้ากับรายการเดิมให้ Admin ตัดสิน ไม่ส่ง Event
      const isLate =
        open.origin === 'VERIFY_TIMEOUT' &&
        (open.submissionId === p.submission_id ||
          (open.submissionId === null && new Date(p.submitted_at).getTime() <= open.createdAt.getTime()));
      if (isLate) {
        await tx.queueItem.update({ where: { id: open.id }, data: { submissionId: p.submission_id } });
        return;
      }
      await this.queue.supersedeOpenItems(tx, p.job_id, 'SUPERSEDED', env.correlation_id);
    }

    await this.queue.createItem(tx, {
      type: 'JOB_REVIEW',
      jobId: p.job_id,
      companyId: p.company_id,
      submissionId: p.submission_id,
      fastTrack: p.fast_track,
      origin: 'FLAGGED_COMPANY',
      correlationId: env.correlation_id,
    });

    await emitJobVerified(this.outbox, tx, {
      correlationId: env.correlation_id,
      payload: {
        job_id: p.job_id,
        submission_id: p.submission_id,
        decision: 'PENDING_REVIEW',
        reasons: [{ code: 'FLAGGED_COMPANY', detail: 'บริษัทอยู่ระหว่างตรวจสอบ (UNDER_REVIEW) — รอ Admin ตัดสิน' }],
        decided_by: 'SYSTEM',
        decided_at: new Date().toISOString(),
      },
    });
    this.log.debug(`queued job=${p.job_id} submission=${p.submission_id}`);
  }

  /**
   * E03: Job ตั้งประกาศเป็น PENDING_REVIEW เพราะ Fail-safe หมดเวลา (VERIFY_TIMEOUT) → สร้างรายการคิว JOB_REVIEW
   * (ถ้ายังไม่มีรายการเปิดของประกาศนั้น) E03 แบบอื่นข้ามในที่นี้
   */
  async handleJobStatusChanged(env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    if (p.to_status !== 'PENDING_REVIEW' || p.reason_code !== 'VERIFY_TIMEOUT') return;
    if (await this.queue.findOpenItem(tx, p.job_id)) return;

    // ผูก fast_track จากสำเนาของ submission เฉพาะเมื่อ E03 ระบุ submission_id — ไม่ระบุ ห้ามเดาจากรอบล่าสุด (อาจเป็นรอบเก่า)
    const snap = p.submission_id ? await tx.jobSubmissionSnapshot.findUnique({ where: { submissionId: p.submission_id } }) : null;

    await this.queue.createItem(tx, {
      type: 'JOB_REVIEW',
      jobId: p.job_id,
      companyId: p.company_id,
      submissionId: p.submission_id ?? null,
      fastTrack: snap?.fastTrack ?? false,
      origin: 'VERIFY_TIMEOUT',
      correlationId: env.correlation_id,
    });
  }
}
