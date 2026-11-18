import { AppException } from '@internpath/common';
import type { InternalJobResponse, InternalStudentResponse } from '@internpath/contracts';
import { bangkokToday, toDateOnly } from '../../state-machine/dates';
import { reapplyBlocked, stateConflict } from '../../state-machine/errors';

/**
 * กฎตอนสร้างใบสมัคร (data-schema §8.1 แถว `— → PENDING`, api-contract §7.2) — ฟังก์ชันล้วน ทดสอบได้โดยไม่มี DB
 * ใช้เฉพาะ code ใน api-contract §2; รายละเอียดใส่ `details[].issue`
 */

/** เหตุผลที่ปุ่มสมัครถูกบล็อก (`GET /me/application-eligibility` → `blocked_reason`) — ตรงกับ code ของ `POST /applications` */
export type ApplyBlockedReason = 'EMAIL_NOT_VERIFIED' | 'ADVISOR_NOT_LINKED' | 'REAPPLY_BLOCKED';

export const emailNotVerified = (): AppException =>
  new AppException('EMAIL_NOT_VERIFIED', 'ต้องยืนยันอีเมลก่อนสมัครงาน', 401);

export const advisorNotLinked = (): AppException =>
  new AppException('ADVISOR_NOT_LINKED', 'ต้องผูกอาจารย์ที่ปรึกษาให้เรียบร้อยก่อนสมัครงาน', 403);

export const companyNotVerified = (): AppException =>
  new AppException('COMPANY_NOT_VERIFIED', 'บริษัทนี้ยังไม่ผ่านการยืนยันหรือถูกระงับ', 403);

/** `issue`: `CONSENT_NOT_ACCEPTED` (ไม่ติ๊ก consent ในคำขอ) / `CONSENT_NOT_RECORDED` (Identity ไม่มี Consent ของบริษัทนี้) */
export const consentRequired = (issue: 'CONSENT_NOT_ACCEPTED' | 'CONSENT_NOT_RECORDED'): AppException =>
  new AppException('CONSENT_REQUIRED', 'ต้องให้ความยินยอมส่งเรซูเม่ให้บริษัทนี้ก่อนสมัคร', 403, [
    { field: 'consent', issue },
  ]);

export const resourceNotFound = (field: 'job_id' | 'resume_id', message: string): AppException =>
  new AppException('NOT_FOUND', message, 404, [{ field, issue: 'NOT_FOUND' }]);

/** เงื่อนไขฝั่งนักศึกษา (ยังไม่รวม `REAPPLY_BLOCKED` ซึ่งดูจากข้อมูลของ Lifecycle เอง) — คืน null เมื่อผ่าน */
export function studentBlockedReason(student: InternalStudentResponse): ApplyBlockedReason | null {
  if (!student.email_verified) return 'EMAIL_NOT_VERIFIED';
  if (student.advisor_link_status !== 'LINKED' || !student.advisor_id) return 'ADVISOR_NOT_LINKED';
  return null;
}

export function blockedReasonError(reason: ApplyBlockedReason): AppException {
  switch (reason) {
    case 'EMAIL_NOT_VERIFIED':
      return emailNotVerified();
    case 'ADVISOR_NOT_LINKED':
      return advisorNotLinked();
    case 'REAPPLY_BLOCKED':
      return reapplyBlocked();
  }
}

/**
 * `application_deadline` ของ Job เป็นวันที่ (`@db.Date`) — สมัครได้ถึงสิ้นวันนั้นตามเวลากรุงเทพ (นับวัน deadline ด้วย)
 * รับทั้ง `YYYY-MM-DD` และ ISO-8601 เต็ม (ใช้ส่วนวันที่) • ไม่มี/อ่านไม่ออก ⇒ ถือว่าเลยแล้ว (fail-closed)
 */
export function isDeadlinePassed(deadline: string | null | undefined, now: Date): boolean {
  if (!deadline) return true;
  const datePart = deadline.slice(0, 10);
  let day: Date;
  try {
    day = toDateOnly(datePart);
  } catch {
    return true;
  }
  return bangkokToday(now).getTime() > day.getTime();
}

/**
 * ประกาศต้อง `PUBLISHED` (ไม่ `CLOSED`) และยังไม่เลย deadline — ใช้ข้อมูลสดจาก `GET /internal/v1/jobs/{id}`
 * ไม่ผ่าน ⇒ `409 STATE_CONFLICT` + `JOB_CLOSED` / `JOB_NOT_PUBLISHED` / `DEADLINE_PASSED`
 */
export function assertJobOpen(job: InternalJobResponse, now: Date): void {
  if (job.status === 'CLOSED') throw stateConflict('JOB_CLOSED');
  if (job.status !== 'PUBLISHED') throw stateConflict('JOB_NOT_PUBLISHED');
  if (isDeadlinePassed(job.application_deadline, now)) throw stateConflict('DEADLINE_PASSED');
}

const normalizeMajor = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase();

/**
 * `major_mismatch` = สาขาของนักศึกษาไม่อยู่ใน `target_majors` ของประกาศ (เตือน HR/อาจารย์ ไม่บล็อกการสมัคร)
 * เทียบแบบตัดช่องว่างและไม่สนตัวพิมพ์ • ประกาศไม่ระบุสาขา ⇒ ไม่ถือว่าไม่ตรง
 */
export function computeMajorMismatch(studentMajor: string, targetMajors: readonly string[] | null | undefined): boolean {
  const targets = (targetMajors ?? []).map(normalizeMajor).filter((m) => m.length > 0);
  if (targets.length === 0) return false;
  return !targets.includes(normalizeMajor(studentMajor));
}
