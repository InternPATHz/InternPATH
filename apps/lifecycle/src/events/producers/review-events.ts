import type { ReviewPublishedPayload, ReviewSubmittedPayload } from '@internpath/contracts';

export const REVIEW_SUBMITTED = 'ReviewSubmitted';
export const REVIEW_PUBLISHED = 'ReviewPublished';
export const REVIEW_MODERATION_RESULT = 'ReviewModerationResult';

export interface ReviewEventSource {
  id: string;
  applicationId: string;
  companyId: string;
  studentUserId: string;
  rating: number;
  title: string | null;
  body: string;
  outcomeLabel: ReviewSubmittedPayload['outcome_label'];
  createdAt: Date;
}

/**
 * E09 (event-contract §5) — ส่งเนื้อหาให้ Verification สแกน; มี `student_user_id` (id ไม่ใช่ข้อมูลส่วนบุคคล)
 * **ไม่มีชื่อ/สาขา/ชั้นปี** ของผู้เขียน
 */
export function buildReviewSubmitted(review: ReviewEventSource): ReviewSubmittedPayload {
  return {
    review_id: review.id,
    application_id: review.applicationId,
    student_user_id: review.studentUserId,
    company_id: review.companyId,
    content: { ...(review.title ? { title: review.title } : {}), body: review.body },
    rating: review.rating as ReviewSubmittedPayload['rating'],
    outcome_label: review.outcomeLabel,
    submitted_at: review.createdAt.toISOString(),
  };
}

/** E11 — สถิติรวมของบริษัทแบบ absolute หลังรวม/หักรีวิวนี้ (`entity_version` = เวอร์ชันของ `company_review_stats`) */
export function buildReviewPublished(
  review: Pick<ReviewEventSource, 'id' | 'companyId' | 'rating'>,
  stats: { reviewCount: number; ratingSum: number; entityVersion: number },
  change: ReviewPublishedPayload['change'],
  at: Date,
): ReviewPublishedPayload {
  return {
    review_id: review.id,
    company_id: review.companyId,
    change,
    rating: review.rating,
    company_review_count: stats.reviewCount,
    company_rating_sum: stats.ratingSum,
    entity_version: stats.entityVersion,
    published_at: at.toISOString(),
  };
}
