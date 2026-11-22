import { CircleCheck, CircleX, Clock5 } from 'lucide-react';
import type { PublicReviewItem } from '@internpath/contracts';

/**
 * การแสดงรีวิวที่ใช้ร่วมกันระหว่างหน้าบริษัทสาธารณะและหน้า HR ตอบรีวิว
 * ป้ายผลการฝึกแสดงคู่รีวิวเสมอ (README 5.5 — กัน Review Silencing: รีวิวของผู้ที่ไม่ผ่านต้องไม่ถูกซ่อนหรือดูเหมือนผ่าน)
 */
export const OUTCOME = {
  PASS: { label: 'ผ่านการฝึกงาน', tone: 'success', icon: CircleCheck },
  FAIL: { label: 'ไม่ผ่านการประเมิน', tone: 'danger', icon: CircleX },
  TERMINATED: { label: 'ยุติการฝึกก่อนกำหนด', tone: 'neutral', icon: Clock5 },
  NO_EVALUATION: { label: 'บริษัทไม่ได้ประเมิน', tone: 'neutral', icon: Clock5 },
} as const;

export function reviewerLabel(review: PublicReviewItem): string {
  if (review.reviewer_name) return review.reviewer_name;
  const parts = [review.display_major, review.display_year !== undefined ? `ชั้นปี ${review.display_year}` : undefined].filter(Boolean);
  return parts.length > 0 ? `ผู้ฝึกงานไม่ระบุชื่อ · ${parts.join(' ')}` : 'ผู้ฝึกงานไม่ระบุชื่อ';
}

export const reviewDateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
