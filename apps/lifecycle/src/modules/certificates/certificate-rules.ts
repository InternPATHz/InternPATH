import { AppException } from '@internpath/common';
import type { ApplicationStatus } from '@internpath/contracts';
import { actualDays } from '../../state-machine/guards';
import { stateConflict } from '../../state-machine/errors';

/** CHECK `certificates_actual_days_check` ใน migration (`actual_days >= 30`) — config ตั้งต่ำกว่านี้ไม่ได้ */
export const CERTIFICATE_DB_MIN_DAYS = 30;

/** ขั้นต่ำที่ใช้จริง = ค่าใน config (`CERT_MIN_ACTUAL_DAYS`) แต่ไม่ต่ำกว่า CHECK ของ DB (ไม่งั้น insert ล้มเป็น 500) */
export const effectiveMinActualDays = (configured: number): number => Math.max(configured, CERTIFICATE_DB_MIN_DAYS);

export interface IssuableApplication {
  status: ApplicationStatus;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
}

/**
 * ออกใบรับรองได้เมื่อ (README §5.2.2, §5.4, api-contract §7.3):
 * 1. บริษัทประเมิน `PASS` — สถานะ `EVALUATED_PASS` หรือ `COMPLETED` ที่ผลประเมินล่าสุดเป็น `PASS`
 *    (อาจารย์บันทึก `academic_result` ก่อน HR กดออกได้ ⇒ ไม่ให้ HR ถูกล็อกถาวร — PM ยืนยันแล้ว api-contract §7.5)
 *    ไม่ตรง ⇒ `409 STATE_CONFLICT` + `NOT_EVALUATED_PASS`
 * 2. ฝึกจริง (`actual_start_date` → `actual_end_date`) ≥ ขั้นต่ำ ⇒ ไม่ถึง `422 CERT_MIN_ACTUAL_DAYS`
 *    (รวม `TERMINATED` ที่ฝึกครบแล้วประเมิน PASS — `actual_end_date` = วันยุติ; ประเมินตามกำหนด = `end_date`)
 * คืนจำนวนวันฝึกจริงเมื่อผ่าน
 */
export function checkCertificateIssuable(
  app: IssuableApplication,
  lastEvaluationResult: 'PASS' | 'FAIL' | null | undefined,
  minActualDays: number,
): { days: number } | { error: AppException } {
  const passed =
    app.status === 'EVALUATED_PASS' || (app.status === 'COMPLETED' && lastEvaluationResult === 'PASS');
  if (!passed) return { error: stateConflict('NOT_EVALUATED_PASS') };
  const days = actualDays(app);
  if (days === null || days < minActualDays) return { error: certMinActualDays() };
  return { days };
}

export const certMinActualDays = (): AppException =>
  new AppException('CERT_MIN_ACTUAL_DAYS', 'ระยะฝึกงานจริงไม่ถึงเกณฑ์ขั้นต่ำสำหรับออกใบรับรอง', 422, [
    { field: 'actual_days', issue: 'BELOW_MIN' },
  ]);

/** ไม่พบ/รูปแบบรหัสผิด/ไม่ใช่ของตน ⇒ 404 รูปแบบเดียวกัน (api-contract §7.5) */
export const certificateNotFound = (): AppException => new AppException('NOT_FOUND', 'ไม่พบใบรับรอง', 404);
