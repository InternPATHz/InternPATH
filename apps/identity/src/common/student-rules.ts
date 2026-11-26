import { AppException } from '@internpath/common';
import type { Prisma } from '../../generated/client';

/** ระบบรับเฉพาะนักศึกษาชั้นปีที่ฝึกงาน (ปี 4 — ผู้ใช้ตัดสิน 2026-11-26) ทั้งตอนอาจารย์เพิ่มและแก้ชั้นปี */
export const INTERN_YEAR = 4;

/**
 * รูปแบบรหัสนักศึกษา: ตัวอักษรนำหน้าได้ไม่เกิน 2 ตัว (เช่น `B` ของบางมหาวิทยาลัย) ตามด้วยตัวเลข 6–13 หลัก
 * ไม่มีช่องว่าง/ขีด (ตรวจหลัง trim + แปลงเป็นตัวพิมพ์ใหญ่) — ครอบรหัส 7, 8, 10, 13 หลัก และแบบ `B6512345`
 */
export const STUDENT_CODE_PATTERN = /^[A-Z]{0,2}[0-9]{6,13}$/;

export function normalizeStudentCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function assertStudentCode(code: string): void {
  if (!STUDENT_CODE_PATTERN.test(code)) {
    throw new AppException('VALIDATION_FAILED',
      'รหัสนักศึกษาต้องเป็นตัวเลข 6–13 หลัก (มีตัวอักษรนำหน้าได้ไม่เกิน 2 ตัว) ไม่มีช่องว่างหรือขีด', 400,
      [{ field: 'student_code', issue: 'STUDENT_CODE_FORMAT' }]);
  }
}

export function assertInternYear(yearLevel: number): void {
  if (yearLevel !== INTERN_YEAR) {
    throw new AppException('VALIDATION_FAILED', `ระบบรับเฉพาะนักศึกษาชั้นปีที่ ${INTERN_YEAR}`, 400,
      [{ field: 'year_level', issue: 'INTERN_YEAR_ONLY' }]);
  }
}

/**
 * กันไม่ให้ Admin ที่ใช้งานได้ (ACTIVE + ยืนยันอีเมล) เหลือ 0 คน — เรียกใน Transaction ก่อนระงับ/ลบบัญชี Admin `targetId`
 * ล็อกแถว Admin ที่ใช้งานได้ทั้งหมด (`FOR UPDATE`) ⇒ คำขอพร้อมกัน (A ระงับ B ขณะ B ระงับ A) ต่อคิวกัน
 * และคำขอหลังเห็นสถานะใหม่หลังคำขอแรก commit ⇒ ได้ `409 LAST_ACTIVE_ADMIN`
 */
export async function assertAnotherActiveAdmin(tx: Prisma.TransactionClient, targetId: string): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM users
    WHERE role = 'PLATFORM_ADMIN' AND status = 'ACTIVE' AND email_verified_at IS NOT NULL
    ORDER BY id FOR UPDATE`;
  if (!rows.some((row) => row.id !== targetId)) {
    throw new AppException('LAST_ACTIVE_ADMIN', 'ต้องเหลือ Admin ที่ใช้งานได้อย่างน้อย 1 คน', 409);
  }
}
