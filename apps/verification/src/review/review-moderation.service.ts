import type { EventEnvelope, ReviewSubmittedPayload } from '@internpath/contracts';
import { OutboxWriter } from '@internpath/common';
import { Injectable, Logger } from '@nestjs/common';
import { emitReviewModerationResult } from '../events/review-moderation-result';
import type { Tx } from '../prisma/types';
import { QueueService } from '../queue/queue.service';
import { RulesRepository } from '../rules/rules.repository';
import { normalizeText } from '../screening/normalize';
import { reviewText, scanReview } from './review-scan';

/** ลบ NUL (Postgres เก็บใน text ไม่ได้) แล้วทำให้ข้อความเป็นรูปมาตรฐานเดียวกับที่สแกน/เก็บ/แสดงให้ Admin */
const clean = (s: string): string => normalizeText(s.replaceAll('\u0000', ''));

@Injectable()
export class ReviewModerationService {
  private readonly logger = new Logger(ReviewModerationService.name);

  constructor(
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
    private readonly rules: RulesRepository,
  ) {}

  /**
   * E09 → สแกน → บันทึก review_moderations → E10 (`PUBLISH`/`HOLD`) (+ รายการ REVIEW_HELD เมื่อพัก) ใน Transaction เดียว
   * (สไลซ์ 3 §5.3) review_id ซ้ำ ⇒ ข้ามเงียบ ไม่ส่ง E10 ซ้ำ; ห้าม log เนื้อรีวิว
   */
  async handleReviewSubmitted(env: EventEnvelope<'ReviewSubmitted', ReviewSubmittedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    const title = clean(p.content.title ?? '').trim() || null;
    const body = clean(p.content.body);
    const scan = scanReview(reviewText(title, body), await this.rules.load(tx));
    const now = new Date();

    const created = await tx.reviewModeration.createMany({
      data: [
        {
          reviewId: p.review_id,
          companyId: p.company_id,
          studentUserId: p.student_user_id,
          rating: p.rating,
          outcomeLabel: p.outcome_label,
          title,
          body,
          decision: scan.hold ? 'HOLD' : 'PUBLISH',
          reasons: scan.reasons,
          status: scan.hold ? 'HELD' : 'PASSED',
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      this.logger.warn(`ReviewSubmitted ซ้ำของรีวิวเดิม: review_id=${p.review_id} event_id=${env.event_id}`);
      return;
    }

    if (scan.hold) {
      const item = await this.queue.createReviewItem(tx, {
        type: 'REVIEW_HELD',
        reviewId: p.review_id,
        companyId: p.company_id,
        origin: 'REVIEW_SCAN',
        correlationId: env.correlation_id,
        now,
      });
      if (item) await tx.reviewModeration.update({ where: { reviewId: p.review_id }, data: { queueItemId: item.id } });
    }

    await emitReviewModerationResult(this.outbox, tx, {
      correlationId: env.correlation_id,
      payload: {
        review_id: p.review_id,
        student_user_id: p.student_user_id,
        decision: scan.hold ? 'HOLD' : 'PUBLISH',
        reasons: scan.reasons,
        decided_by: 'SYSTEM',
        decided_at: now.toISOString(),
      },
    });
  }
}
