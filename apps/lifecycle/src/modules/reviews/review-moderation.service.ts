import { InvalidMessageError, OutboxWriter, isUuid } from '@internpath/common';
import type { EventEnvelope, ReviewModerationResultPayload, ReviewStatus } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Review } from '../../../generated/client';
import { REVIEW_PUBLISHED, buildReviewPublished } from '../../events/producers/review-events';
import type { Tx } from '../../prisma/types';
import { type Actor, StatusHistoryWriter, SYSTEM_ACTOR } from '../../state-machine/status-history.writer';

type Decision = ReviewModerationResultPayload['decision'];

const DECISIONS: readonly Decision[] = ['PUBLISH', 'HOLD', 'ADMIN_PUBLISH', 'ADMIN_REMOVE'];

/** สถานะต้นทางที่แต่ละคำตัดสินใช้ได้ → สถานะปลายทาง (event-contract E10 "กติกาของผู้รับ — สไลซ์ 3 แบบ A") */
const RULES: Readonly<Record<Decision, { from: readonly ReviewStatus[]; to: ReviewStatus }>> = {
  PUBLISH: { from: ['SUBMITTED'], to: 'PUBLISHED' },
  HOLD: { from: ['SUBMITTED'], to: 'HELD' },
  ADMIN_PUBLISH: { from: ['SUBMITTED', 'HELD'], to: 'PUBLISHED' },
  ADMIN_REMOVE: { from: ['SUBMITTED', 'HELD', 'PUBLISHED'], to: 'REMOVED' },
};

export type ModerationOutcome = 'applied' | 'skipped';

/**
 * Consumer E10 `ReviewModerationResult` (verification → lifecycle) — handler รันใน `tx` เดียวกับ `processed_events`
 * (กันซ้ำด้วย `event_id` ที่ libs/common) • ล้มเหลว ⇒ throw ให้ retry; payload ผิดรูป ⇒ `InvalidMessageError` (dead-letter ทันที)
 *
 * - `PUBLISH`/`ADMIN_PUBLISH` ⇒ `PUBLISHED` + บวก `company_review_stats` + E11 (ค่ารวม absolute + `entity_version`)
 * - `HOLD` ⇒ `HELD` (พักเข้าคิว Admin ไม่ตีกลับ — README §5.5)
 * - `ADMIN_REMOVE` จาก `SUBMITTED`/`HELD` ⇒ `REMOVED`; จาก `PUBLISHED` ⇒ `REMOVED` + หักสถิติ + E11 ใหม่ให้ตัวนับตรง
 * - `ADMIN_PUBLISH` ของที่ `PUBLISHED` อยู่แล้ว ⇒ ข้ามเงียบ • สถานะไม่ตรงอื่นๆ / ไม่พบรีวิว ⇒ ข้ามพร้อม log **ไม่ throw**
 * - ไม่ log เนื้อหารีวิว/เหตุผล (อาจมีข้อมูลอ่อนไหว) — log แค่ id และสถานะ
 */
@Injectable()
export class ReviewModerationService {
  private readonly logger = new Logger(ReviewModerationService.name);

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly history: StatusHistoryWriter,
  ) {}

  async handle(envelope: EventEnvelope<string, ReviewModerationResultPayload>, tx: Tx): Promise<ModerationOutcome> {
    const payload = validate(envelope.payload);
    const decidedAt = new Date(payload.decided_at);

    // ล็อกแถวรีวิวก่อนอ่านสถานะ — E10 ของรีวิวเดียวกันที่มาพร้อมกันจะรอกันตามลำดับ
    await tx.$queryRaw`SELECT id FROM reviews WHERE id = ${payload.review_id}::uuid FOR UPDATE`;
    const review = await tx.review.findUnique({ where: { id: payload.review_id } });
    if (!review) {
      this.logger.warn(`E10 ข้าม: ไม่พบรีวิว ${payload.review_id}`);
      return 'skipped';
    }

    const rule = RULES[payload.decision];
    if (!rule.from.includes(review.status)) {
      if (!(payload.decision === 'ADMIN_PUBLISH' && review.status === 'PUBLISHED')) {
        this.logger.warn(`E10 ข้าม: ${payload.decision} ใช้กับรีวิวสถานะ ${review.status} ไม่ได้ (${review.id})`);
      }
      return 'skipped';
    }

    const after = await tx.review.update({
      where: { id: review.id },
      data: {
        status: rule.to,
        ...(rule.to === 'PUBLISHED' ? { publishedAt: decidedAt } : {}),
      },
    });

    const actor: Actor = payload.decided_by === 'ADMIN' ? { userId: null, role: 'PLATFORM_ADMIN' } : SYSTEM_ACTOR;
    await this.history.record(tx, {
      entity: 'REVIEW',
      entityId: review.id,
      fromStatus: review.status,
      toStatus: rule.to,
      actor,
      // เก็บแค่รหัสเหตุผล ไม่เก็บ `detail` (อาจคัดลอกข้อความในรีวิวมา)
      reason: [...new Set(payload.reasons.map((r) => r.code))].join(',') || null,
      correlationId: envelope.correlation_id,
      occurredAt: decidedAt,
    });

    if (rule.to === 'PUBLISHED') {
      await this.publishStats(tx, after, +1, envelope.correlation_id, decidedAt);
    } else if (review.status === 'PUBLISHED' && rule.to === 'REMOVED') {
      await this.publishStats(tx, after, -1, envelope.correlation_id, decidedAt);
    }
    return 'applied';
  }

  /** ปรับตัวนับของบริษัทแบบ atomic แล้วส่ง E11 ด้วยค่ารวมหลังปรับ (absolute ไม่ใช่ delta — event-contract E11) */
  /**
   * หักสถิติเมื่อถอดรีวิวที่เผยแพร่แล้ว — `updateMany` + guard ไม่ให้ติดลบ (PM รีวิว #57: `update` ของแถวที่ไม่มีจะ error แล้ว retry/DLQ)
   * ไม่มีแถว/ค่าไม่พอหัก (ข้อมูลไม่สอดคล้อง) ⇒ log แล้วสร้าง/คงแถวค่าเดิมแต่เพิ่ม `entity_version` เพื่อส่ง E11 ค่าปัจจุบัน ไม่ throw
   */
  private async decrementStats(tx: Tx, review: Review) {
    const { count } = await tx.companyReviewStats.updateMany({
      where: { companyId: review.companyId, reviewCount: { gte: 1 }, ratingSum: { gte: review.rating } },
      data: { reviewCount: { decrement: 1 }, ratingSum: { decrement: review.rating }, entityVersion: { increment: 1 } },
    });
    if (count === 1) return tx.companyReviewStats.findUniqueOrThrow({ where: { companyId: review.companyId } });
    this.logger.warn(`E10 ADMIN_REMOVE: สถิติรีวิวของบริษัท ${review.companyId} ไม่พอหัก — ไม่หัก (ข้อมูลไม่สอดคล้อง)`);
    return tx.companyReviewStats.upsert({
      where: { companyId: review.companyId },
      create: { companyId: review.companyId, reviewCount: 0, ratingSum: 0, entityVersion: 1 },
      update: { entityVersion: { increment: 1 } },
    });
  }

  private async publishStats(tx: Tx, review: Review, direction: 1 | -1, correlationId: string, at: Date): Promise<void> {
    const stats =
      direction === 1
        ? await tx.companyReviewStats.upsert({
            where: { companyId: review.companyId },
            create: { companyId: review.companyId, reviewCount: 1, ratingSum: review.rating, entityVersion: 1 },
            update: {
              reviewCount: { increment: 1 },
              ratingSum: { increment: review.rating },
              entityVersion: { increment: 1 },
            },
          })
        : await this.decrementStats(tx, review);
    await this.outbox.add(tx, {
      type: REVIEW_PUBLISHED,
      aggregateId: review.companyId,
      correlationId,
      payload: buildReviewPublished(review, stats, at),
    });
  }
}

const ISO_UTC_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** payload ผิดรูป = ข้อผิดพลาดของผู้ส่ง ⇒ dead-letter ทันที ไม่ retry (ห้ามใส่ค่าใน message — อาจมีข้อมูลอ่อนไหว) */
function validate(payload: unknown): ReviewModerationResultPayload {
  const p = payload as Partial<ReviewModerationResultPayload> | null;
  const ok =
    !!p &&
    typeof p.review_id === 'string' &&
    isUuid(p.review_id) &&
    typeof p.decision === 'string' &&
    DECISIONS.includes(p.decision) &&
    Array.isArray(p.reasons) &&
    p.reasons.every((r) => !!r && typeof r.code === 'string') &&
    (p.decided_by === 'SYSTEM' || p.decided_by === 'ADMIN') &&
    typeof p.decided_at === 'string' &&
    ISO_UTC_MS.test(p.decided_at) &&
    !Number.isNaN(Date.parse(p.decided_at));
  if (!ok) throw new InvalidMessageError('ReviewModerationResult payload ไม่ถูกต้อง');
  return p as ReviewModerationResultPayload;
}
