import { randomUUID } from 'node:crypto';
import type { JobVerifiedReason } from '@internpath/contracts';
import { AppException, JwtClaims, OutboxWriter } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import type { Evaluation } from '@prisma/client';
import { emitJobVerified } from '../events/job-verified';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/types';
import { QueueService } from '../queue/queue.service';
import type { MatchedKeyword } from '../screening/types';

export interface JobResultView {
  risk_level: string;
  risk_score: number;
  reasons: unknown;
  matched_keywords: Array<{ term: string; field: string; negated: boolean }>;
  is_appeal: boolean;
  can_appeal: boolean;
  /** เหตุผลที่ Admin ปฏิเสธ (มีเฉพาะเมื่อผลล่าสุดถูก Admin ปฏิเสธ) */
  admin_reason?: string;
}

@Injectable()
export class AppealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
  ) {}

  /** ผลตรวจล่าสุดของประกาศ — เลือกจาก submitted_at (เวลาที่ Job ส่งตรวจ) ไม่ใช่เวลาที่ประมวลผล */
  private async latestEvaluation(jobId: string, db: Pick<Tx, 'evaluation'> = this.prisma): Promise<Evaluation> {
    const latest = await db.evaluation.findFirst({ where: { jobId }, orderBy: { submittedAt: 'desc' } });
    if (!latest) throw new AppException('NOT_FOUND', 'ไม่พบผลการตรวจของประกาศนี้', 404);
    return latest;
  }

  private assertOwner(user: JwtClaims, evaluation: Evaluation): void {
    if (user.role === 'COMPANY_HR' && user.company_id !== evaluation.companyId) {
      throw new AppException('FORBIDDEN_COMPANY', 'ไม่มีสิทธิ์เข้าถึงประกาศของบริษัทอื่น', 403);
    }
  }

  async getResult(jobId: string, user: JwtClaims): Promise<JobResultView> {
    const latest = await this.latestEvaluation(jobId);
    this.assertOwner(user, latest);

    const appeal = await this.prisma.appeal.findUnique({ where: { jobId } });
    // มีรายการคิวเปิดอยู่ (เช่น Fail-safe ที่ผลตรวจมาทีหลัง) = Admin กำลังจะตัดสินอยู่แล้ว ยังอุทธรณ์ไม่ได้
    const openItem = await this.queue.findOpenItem(this.prisma, jobId);
    const rejection = await this.prisma.queueItem.findFirst({
      where: { targetId: jobId, submissionId: latest.submissionId, resolution: 'ADMIN_REJECT' },
      orderBy: { resolvedAt: 'desc' },
    });
    let adminReason: string | null = null;
    if (rejection) {
      const hist = await this.prisma.statusHistory.findFirst({
        where: { entity: 'QUEUE_ITEM', entityId: rejection.id, toStatus: 'RESOLVED', actorId: { not: null } },
        orderBy: { occurredAt: 'desc' },
      });
      adminReason = hist?.reason ?? null;
    }

    return {
      risk_level: latest.riskLevel,
      risk_score: latest.riskScore,
      reasons: latest.reasons,
      matched_keywords: ((latest.matchedKeywords ?? []) as unknown as MatchedKeyword[]).map((m) => ({
        term: m.term,
        field: m.field,
        negated: m.negated,
      })),
      is_appeal: appeal?.submissionId === latest.submissionId,
      can_appeal: latest.decision === 'AUTO_REJECT' && !appeal && !openItem,
      ...(adminReason ? { admin_reason: adminReason } : {}),
    };
  }

  /**
   * HR อุทธรณ์ผลตรวจที่ถูก AUTO_REJECT (1 ครั้งต่อประกาศ — README 5.1.5): ใน Transaction เดียวสร้าง appeals,
   * รายการคิว JOB_APPEAL และ JobVerified(APPEAL_ACCEPTED) ให้ Job ย้ายประกาศไป PENDING_REVIEW
   * การกันซ้ำ/ขนานใช้ UNIQUE(job_id) ด้วย createMany skipDuplicates (ตัวที่สองได้ 0 แถว → 409)
   */
  async appeal(jobId: string, statement: string, user: JwtClaims, correlationId?: string): Promise<{ id: string; status: 'OPEN' }> {
    const used = () => new AppException('APPEAL_ALREADY_USED', 'ประกาศนี้ใช้สิทธิ์อุทธรณ์ไปแล้ว', 409);
    const cid = correlationId ?? randomUUID();
    // อ่านผลล่าสุด ตรวจเงื่อนไข และเขียนทั้งหมดใน Transaction เดียว — ไม่ผูกอุทธรณ์กับ submission ที่ถูกแทนที่ระหว่างทาง
    return this.prisma.$transaction(async (tx) => {
      const latest = await this.latestEvaluation(jobId, tx);
      this.assertOwner(user, latest);
      if (latest.decision !== 'AUTO_REJECT') {
        throw new AppException('STATE_CONFLICT', 'ผลตรวจล่าสุดไม่ใช่การปฏิเสธอัตโนมัติ จึงอุทธรณ์ไม่ได้', 409);
      }
      if (await tx.appeal.findUnique({ where: { jobId }, select: { id: true } })) throw used();
      // มีรายการคิวเปิดอยู่แล้ว (เช่น Fail-safe ที่ผลตรวจมาทีหลัง) = Admin กำลังจะตัดสิน อุทธรณ์ซ้อนไม่ได้ และไม่ใช้สิทธิ์ทิ้ง
      if (await this.queue.findOpenItem(tx, jobId)) {
        // ถ้ารายการนั้นคือ JOB_APPEAL ของอุทธรณ์ที่เพิ่ง commit (สองคำขอซ้อนกัน) ต้องตอบว่าใช้สิทธิ์ไปแล้ว ไม่ใช่ STATE_CONFLICT
        if (await tx.appeal.findUnique({ where: { jobId }, select: { id: true } })) throw used();
        throw new AppException('STATE_CONFLICT', 'ประกาศนี้มีรายการรอผู้ดูแลตัดสินอยู่แล้ว จึงอุทธรณ์ไม่ได้', 409);
      }

      const id = randomUUID();
      const { count } = await tx.appeal.createMany({
        data: [{ id, jobId, submissionId: latest.submissionId, statement, status: 'OPEN' }],
        skipDuplicates: true,
      });
      if (count === 0) throw used();

      await this.queue.createItem(tx, {
        type: 'JOB_APPEAL',
        jobId,
        companyId: latest.companyId,
        submissionId: latest.submissionId,
        riskLevel: 'HIGH',
        fastTrack: latest.fastTrack,
        origin: 'APPEAL',
        correlationId: cid,
      });
      await emitJobVerified(this.outbox, tx, {
        correlationId: cid,
        payload: {
          job_id: jobId,
          submission_id: latest.submissionId,
          decision: 'APPEAL_ACCEPTED',
          risk_score: latest.riskScore,
          risk_level: latest.riskLevel,
          reasons: (latest.reasons ?? []) as unknown as JobVerifiedReason[],
          is_appeal: true,
          decided_by: 'SYSTEM',
          decided_at: new Date().toISOString(),
        },
      });
      return { id, status: 'OPEN' as const };
    });
  }
}
