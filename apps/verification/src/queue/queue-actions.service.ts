import { randomUUID } from 'node:crypto';
import type { JobVerifiedReason } from '@internpath/contracts';
import { AppException, OutboxWriter } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { asUuid } from '../common/uuid';
import { emitJobVerified } from '../events/job-verified';
import { PrismaService } from '../prisma/prisma.service';

type Decision = 'ADMIN_APPROVE' | 'ADMIN_REJECT';

@Injectable()
export class QueueActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditService,
  ) {}

  approve(id: string, admin: { sub: string }, correlationId?: string): Promise<void> {
    return this.resolve(id, admin, 'ADMIN_APPROVE', undefined, correlationId);
  }

  reject(id: string, admin: { sub: string }, reason: string, correlationId?: string): Promise<void> {
    return this.resolve(id, admin, 'ADMIN_REJECT', reason, correlationId);
  }

  /**
   * ตัดสินรายการคิวของประกาศ (JOB_REVIEW/JOB_APPEAL) ใน Transaction เดียว: ปิดรายการ → ส่ง JobVerified → status_history
   * → audit (+ appeals ถ้าเป็นอุทธรณ์) การปิดใช้ `updateMany where status <> 'RESOLVED'` เป็นตัวกันสองคนกดพร้อมกัน
   * (คนที่สองได้ 0 แถว → 409 และ rollback ทั้งก้อน)
   * เหตุผลการปฏิเสธเก็บใน status_history.reason (resolution เก็บแค่รหัส ADMIN_APPROVE/ADMIN_REJECT)
   */
  private async resolve(id: string, admin: { sub: string }, decision: Decision, reason: string | undefined, correlationId?: string): Promise<void> {
    const cid = correlationId ?? randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.queueItem.findUnique({ where: { id } });
      if (!item) throw new AppException('NOT_FOUND', 'ไม่พบรายการคิว', 404);
      if (item.type !== 'JOB_REVIEW' && item.type !== 'JOB_APPEAL') {
        throw new AppException('UNSUPPORTED_ITEM_TYPE', 'รายการชนิดนี้ยังไม่รองรับการตัดสิน', 422);
      }
      if (item.status === 'RESOLVED') throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);
      if (!item.submissionId) {
        throw new AppException('SUBMISSION_UNKNOWN', 'รายการนี้ยังไม่ทราบ submission ที่ต้องตัดสิน', 422);
      }

      const now = new Date();
      const { count } = await tx.queueItem.updateMany({
        where: { id, status: { not: 'RESOLVED' } },
        data: { status: 'RESOLVED', resolution: decision, resolvedAt: now },
      });
      if (count === 0) throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);

      const evaluation = await tx.evaluation.findUnique({ where: { submissionId: item.submissionId } });
      const reasons: JobVerifiedReason[] = ((evaluation?.reasons ?? []) as unknown as JobVerifiedReason[]).slice();
      if (decision === 'ADMIN_REJECT' && reason) reasons.push({ code: 'ADMIN_REASON', detail: reason });

      await emitJobVerified(this.outbox, tx, {
        correlationId: cid,
        payload: {
          job_id: item.targetId,
          submission_id: item.submissionId,
          decision,
          ...(evaluation ? { risk_score: evaluation.riskScore, risk_level: evaluation.riskLevel } : {}),
          reasons,
          is_appeal: item.isAppeal,
          decided_by: 'ADMIN',
          decided_at: now.toISOString(),
        },
      });

      if (item.type === 'JOB_APPEAL') {
        await tx.appeal.updateMany({
          where: { jobId: item.targetId },
          data: { status: decision === 'ADMIN_APPROVE' ? 'APPROVED' : 'DENIED', decidedBy: admin.sub, decidedAt: now },
        });
      }

      await tx.statusHistory.create({
        data: {
          entity: 'QUEUE_ITEM',
          entityId: id,
          fromStatus: item.status,
          toStatus: 'RESOLVED',
          actorId: admin.sub,
          actorRole: 'PLATFORM_ADMIN',
          reason: reason ?? null,
          correlationId: asUuid(cid),
          occurredAt: now,
        },
      });
      await this.audit.record(tx, {
        adminId: admin.sub,
        action: decision === 'ADMIN_APPROVE' ? 'QUEUE_APPROVE' : 'QUEUE_REJECT',
        targetType: 'queue_item',
        targetId: id,
        before: { status: item.status },
        after: { status: 'RESOLVED', resolution: decision },
        reason,
        correlationId: cid,
      });
    });
  }
}
