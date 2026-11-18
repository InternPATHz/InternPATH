import type { ApplicationStatus } from '@internpath/contracts';

export type ReviewOutcome = 'PASS' | 'FAIL' | 'TERMINATED' | 'NO_EVALUATION';

/**
 * สถานะที่เขียนรีวิวได้ (README §5.5): HR ประเมินแล้ว (`EVALUATED_PASS`/`EVALUATED_FAIL` เป็นต้นไป)
 * หรือสิ้นสุดแบบ `TERMINATED`/`NO_EVALUATION` — "เป็นต้นไป" รวมการโต้แย้ง/ประเมินซ้ำ/`COMPLETED`
 * สถานะอื่น ⇒ `422 EVALUATION_NOT_OPEN` + `REVIEW_NOT_OPEN` (api-contract §7.6)
 */
export const REVIEWABLE_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'EVALUATED_PASS',
  'EVALUATED_FAIL',
  'FAIL_DISPUTED',
  'REEVALUATION_REQUESTED',
  'COMPLETED',
  'TERMINATED',
  'NO_EVALUATION',
]);

export interface OutcomeSource {
  status: ApplicationStatus;
  terminatedBy: string | null;
}

/**
 * ป้ายผลการฝึกที่แสดงคู่รีวิว (README §5.5 — กัน Review Silencing) เก็บตามสถานะตอนเขียนรีวิว:
 * - ยุติก่อนกำหนด (`terminated_by` มีค่า — รวมกรณีฝึกครบ 30 วันแล้วบริษัทประเมินต่อ) ⇒ `TERMINATED` (UAT-20)
 * - `NO_EVALUATION` ⇒ `NO_EVALUATION` (UAT-22)
 * - นอกนั้นใช้ผลประเมินล่าสุดของบริษัท (`PASS`/`FAIL`) — โต้แย้ง/ประเมินซ้ำอยู่ ⇒ ผลล่าสุดที่มี (UAT-07)
 * คืน `null` เมื่อหาผลไม่ได้ (ไม่ควรเกิด — สถานะหลังประเมินต้องมีแถว `evaluations`)
 */
export function outcomeLabel(app: OutcomeSource, lastEvaluation: 'PASS' | 'FAIL' | null | undefined): ReviewOutcome | null {
  if (app.status === 'NO_EVALUATION') return 'NO_EVALUATION';
  if (app.terminatedBy || app.status === 'TERMINATED') return 'TERMINATED';
  if (app.status === 'EVALUATED_PASS') return 'PASS';
  if (app.status === 'EVALUATED_FAIL' || app.status === 'FAIL_DISPUTED') return 'FAIL';
  return lastEvaluation ?? null;
}
