import { AppException } from '@internpath/common';

/**
 * Error ของ State Machine — ใช้เฉพาะ code ที่อยู่ใน api-contract §2 (ห้ามตั้ง code ใหม่เอง)
 * รายละเอียดเพิ่มเติมใส่ใน `details[].issue` แทน
 */
export const stateConflict = (issue = 'INVALID_TRANSITION'): AppException =>
  new AppException('STATE_CONFLICT', 'สถานะใบสมัครเปลี่ยนไปแล้วหรือทำรายการนี้ไม่ได้ในสถานะปัจจุบัน', 409, [{ issue }]);

export const reasonRequired = (): AppException =>
  new AppException('REASON_REQUIRED', 'ต้องระบุเหตุผล', 400, [{ field: 'reason', issue: 'REQUIRED' }]);

export const invalidPeriod = (field = 'end_date'): AppException =>
  new AppException('INVALID_PERIOD_MIN_30_DAYS', 'ช่วงฝึกงานต้องห่างกันอย่างน้อย 30 วัน', 422, [
    { field, issue: 'MIN_30_DAYS' },
  ]);

export const alreadyConfirmedElsewhere = (): AppException =>
  new AppException('ALREADY_CONFIRMED_ELSEWHERE', 'นักศึกษายืนยันการฝึกงานที่อื่นแล้ว', 403);

export const alreadyApplied = (): AppException =>
  new AppException('ALREADY_APPLIED', 'มีใบสมัครประกาศนี้ที่ยังดำเนินอยู่แล้ว', 409);

export const evaluationNotOpen = (issue: string): AppException =>
  new AppException('EVALUATION_NOT_OPEN', 'ยังไม่เปิดให้ประเมินผล', 422, [{ issue }]);

export const disputeWindowClosed = (): AppException =>
  new AppException('DISPUTE_WINDOW_CLOSED', 'เลยกำหนดโต้แย้งผลประเมิน 7 วันแล้ว', 422);

export const reapplyBlocked = (): AppException =>
  new AppException('REAPPLY_BLOCKED', 'ผ่านการฝึกงานแล้ว สมัครใหม่ได้เมื่อผู้ดูแลระบบปลดล็อกเท่านั้น', 403);

export const validationFailed = (field: string, issue: string): AppException =>
  new AppException('VALIDATION_FAILED', 'ข้อมูลไม่ถูกต้อง', 400, [{ field, issue }]);

export const applicationNotFound = (): AppException => new AppException('NOT_FOUND', 'ไม่พบใบสมัคร', 404);

/** ชื่อ partial unique index ใน migration `20261115140000_lifecycle_foundation` */
export const ONE_ACTIVE_CONFIRMATION_INDEX = 'applications_one_active_confirmation_per_student';
export const NO_DUPLICATE_ACTIVE_PER_JOB_INDEX = 'applications_no_duplicate_active_per_job';

/**
 * แปลง unique violation ของ partial unique index เป็น error ทางธุรกิจ
 * Prisma (P2002) บอกได้ทั้งชื่อ index หรือรายชื่อคอลัมน์ ส่วน pg ดิบ (23505) บอกชื่อ constraint — รองรับทั้งสามแบบ
 * คืน `undefined` เมื่อไม่ใช่ error ของสอง index นี้ (ให้ผู้เรียก throw ต่อเอง)
 */
export function mapApplicationUniqueViolation(error: unknown): AppException | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { code?: unknown; constraint?: unknown; message?: unknown; meta?: { target?: unknown } };
  // P2034 = write conflict/deadlock ของ Prisma ⇒ อีกคำสั่งชนะไปก่อน
  if (e.code === 'P2034' || e.code === '40P01') return stateConflict('CONCURRENT_UPDATE');
  if (e.code !== 'P2002' && e.code !== '23505') return undefined;

  const target = e.meta?.target;
  const haystack = [
    typeof e.constraint === 'string' ? e.constraint : '',
    typeof target === 'string' ? target : '',
    typeof e.message === 'string' ? e.message : '',
  ].join(' ');
  const columns = Array.isArray(target) ? target.map(String) : [];

  if (haystack.includes(ONE_ACTIVE_CONFIRMATION_INDEX)) return alreadyConfirmedElsewhere();
  if (haystack.includes(NO_DUPLICATE_ACTIVE_PER_JOB_INDEX)) return alreadyApplied();
  if (columns.length === 1 && columns[0] === 'student_user_id') return alreadyConfirmedElsewhere();
  if (columns.length === 2 && columns.includes('student_user_id') && columns.includes('job_id')) {
    return alreadyApplied();
  }
  return undefined;
}
