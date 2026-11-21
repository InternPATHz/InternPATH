import { randomUUID } from 'node:crypto';
import type { ReviewModerationResultPayload } from '@internpath/contracts';
import { AppException, OutboxWriter } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/client';
import { AuditService } from '../audit/audit.service';
import { asUuid } from '../common/uuid';
import { lockScope } from '../common/locks';
import { emitReviewModerationResult } from '../events/review-moderation-result';
import { PrismaService } from '../prisma/prisma.service';

type Kind = 'PUBLISH' | 'REMOVE';

@Injectable()
export class ReviewActionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly audit: AuditService,
  ) {}

  publish(id: string, admin: { sub: string }, reason: string | undefined, correlationId?: string): Promise<void> {
    return this.decide(id, admin, 'PUBLISH', reason, correlationId);
  }

  remove(id: string, admin: { sub: string }, reason: string, correlationId?: string): Promise<void> {
    return this.decide(id, admin, 'REMOVE', reason, correlationId);
  }

  /**
   * ตัดสินรายการ REVIEW_REPORT ใน Transaction เดียว (สไลซ์ 3 §5.5): ล็อกรีวิว (ร่วมกับการรายงาน) →
   * ปิดรายการด้วย `updateMany where status <> 'RESOLVED'` → เปลี่ยนสถานะรีวิวด้วยเงื่อนไขสถานะที่คาด → E10 → history → audit
   * ขั้นใดล้มเหลว (409) rollback ทั้งก้อน ห้าม log เนื้อรีวิว/เหตุผล
   */
  private async decide(id: string, admin: { sub: string }, kind: Kind, reason: string | undefined, correlationId?: string): Promise<void> {
    const cid = asUuid(correlationId ?? randomUUID());
    await this.prisma.$transaction(async (tx) => {
      const probe = await tx.queueItem.findUnique({ where: { id }, select: { type: true, targetId: true } });
      if (!probe) throw new AppException('NOT_FOUND', 'ไม่พบรายการคิว', 404);
      if (probe.type !== 'REVIEW_REPORT') {
        throw new AppException('UNSUPPORTED_ITEM_TYPE', 'รายการชนิดนี้ไม่ใช่การตรวจรีวิว', 422);
      }
      await lockScope(tx, 'review', probe.targetId);
      const item = await tx.queueItem.findUniqueOrThrow({ where: { id } });
      if (item.status === 'RESOLVED') throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);

      const now = new Date();
      const decision = kind === 'PUBLISH' ? 'ADMIN_PUBLISH' : 'ADMIN_REMOVE';
      const closed = await tx.queueItem.updateMany({
        where: { id, status: { not: 'RESOLVED' } },
        data: { status: 'RESOLVED', resolution: decision, resolvedAt: now },
      });
      if (closed.count === 0) throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);

      const expected = ['PASSED' as const, 'ADMIN_PUBLISHED' as const];
      const reasons: ReviewModerationResultPayload['reasons'] = [
        { code: 'REPORTED' as const },
        { code: 'ADMIN' as const, ...(reason ? { detail: reason } : {}) },
      ];
      const moderated = await tx.reviewModeration.updateMany({
        where: { reviewId: item.targetId, status: { in: expected } },
        data: { status: kind === 'PUBLISH' ? 'ADMIN_PUBLISHED' : 'ADMIN_REMOVED', decision, reasons: reasons as unknown as Prisma.InputJsonValue },
      });
      if (moderated.count === 0) throw new AppException('STATE_CONFLICT', 'สถานะของรีวิวเปลี่ยนไปแล้ว', 409);
      const review = await tx.reviewModeration.findUniqueOrThrow({ where: { reviewId: item.targetId }, select: { studentUserId: true } });

      await emitReviewModerationResult(this.outbox, tx, {
        correlationId: cid,
        payload: { review_id: item.targetId, student_user_id: review.studentUserId, decision, reasons, decided_by: 'ADMIN', decided_at: now.toISOString() },
      });
      await tx.statusHistory.create({
        data: {
          entity: 'QUEUE_ITEM',
          entityId: id,
          fromStatus: item.status,
          toStatus: 'RESOLVED',
          actorId: admin.sub,
          actorRole: 'PLATFORM_ADMIN',
          reason: reason ?? null,
          correlationId: cid,
          occurredAt: now,
        },
      });
      await this.audit.record(tx, {
        adminId: admin.sub,
        action: kind === 'PUBLISH' ? 'REVIEW_PUBLISH' : 'REVIEW_REMOVE',
        targetType: 'review',
        targetId: item.targetId,
        before: { queue_item_id: id, queue_status: item.status },
        after: { queue_status: 'RESOLVED', decision },
        reason,
        correlationId: cid,
      });
    });
  }
}
