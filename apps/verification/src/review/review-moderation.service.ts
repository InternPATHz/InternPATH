import type { EventEnvelope, ReviewSubmittedPayload } from '@internpath/contracts';
import { OutboxWriter } from '@internpath/common';
import { Injectable, Logger } from '@nestjs/common';
import { normalizeText } from '../common/text';
import { emitReviewModerationResult } from '../events/review-moderation-result';
import type { Tx } from '../prisma/types';

/** ลบ NUL (Postgres เก็บใน text ไม่ได้) แล้วทำให้ข้อความเป็นรูปมาตรฐานเดียวกับที่เก็บ/แสดงให้ Admin */
const clean = (s: string): string => normalizeText(s.replaceAll('\u0000', ''));

@Injectable()
export class ReviewModerationService {
  private readonly logger = new Logger(ReviewModerationService.name);

  constructor(private readonly outbox: OutboxWriter) {}

  /**
   * E09 → บันทึก review_moderations (PASSED) → E10 `PUBLISH` ใน Transaction เดียว
   * ปรับ Requirement 2026-11-21: ไม่สแกนคำต้องห้าม/ข้อมูลติดต่ออีกแล้ว — รีวิวเผยแพร่ทันที; ผู้ใช้รายงานได้ภายหลัง (คิว REVIEW_REPORT)
   * review_id ซ้ำ ⇒ ข้ามเงียบ ไม่ส่ง E10 ซ้ำ; ห้าม log เนื้อรีวิว
   */
  async handleReviewSubmitted(env: EventEnvelope<'ReviewSubmitted', ReviewSubmittedPayload>, tx: Tx): Promise<void> {
    const p = env.payload;
    const title = clean(p.content.title ?? '').trim() || null;
    const body = clean(p.content.body);
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
          decision: 'PUBLISH',
          reasons: [],
          status: 'PASSED',
          createdAt: now,
        },
      ],
      skipDuplicates: true,
    });
    if (created.count === 0) {
      this.logger.warn(`ReviewSubmitted ซ้ำของรีวิวเดิม: review_id=${p.review_id} event_id=${env.event_id}`);
      return;
    }

    await emitReviewModerationResult(this.outbox, tx, {
      correlationId: env.correlation_id,
      payload: {
        review_id: p.review_id,
        student_user_id: p.student_user_id,
        decision: 'PUBLISH',
        reasons: [],
        decided_by: 'SYSTEM',
        decided_at: now.toISOString(),
      },
    });
  }
}
