import { InvalidMessageError, isUuid } from '@internpath/common';
import type { ApplicationStatus } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';
import type { Tx } from '../../prisma/types';

/**
 * ตัวช่วยร่วมของ Consumer (หัวข้อ 1.11)
 * - payload ผิดรูป ⇒ `InvalidMessageError` (libs/common ส่ง dead-letter ทันที ไม่ retry) — แบบเดียวกับ E10 (1.8) และ E15 ของ Job
 * - Freeze/Unfreeze ใบสมัคร: เวลา Freeze สะสมลง `sla_paused_seconds` (Scheduler 1.10 หักออกก่อนนับ)
 */

const UTC_TIMESTAMP = /^(?!0000)\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

export function invalid(type: string, field: string): never {
  // ไม่ใส่ค่าใน message (อาจเป็นข้อมูลส่วนบุคคล) — บอกแค่ชื่อฟิลด์
  throw new InvalidMessageError(`Invalid ${type} payload: ${field}`);
}

export function requireUuid(type: string, field: string, value: unknown): string {
  if (typeof value !== 'string' || !isUuid(value)) invalid(type, field);
  return value;
}

export function optionalUuid(type: string, field: string, value: unknown): string | undefined {
  return value === undefined || value === null ? undefined : requireUuid(type, field, value);
}

export function requireVersion(type: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) invalid(type, 'entity_version');
  return value;
}

export function requireTimestamp(type: string, field: string, value: unknown): Date {
  if (typeof value !== 'string' || !UTC_TIMESTAMP.test(value)) invalid(type, field);
  const at = new Date(value);
  if (!Number.isFinite(at.getTime()) || at.toISOString().slice(0, 19) !== value.slice(0, 19)) invalid(type, field);
  return at;
}

export function requireOneOf<T extends string>(type: string, field: string, value: unknown, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !(allowed as readonly string[]).includes(value)) invalid(type, field);
  return value as T;
}

/**
 * ใบสมัครที่ "ค้าง" ก่อนเริ่มฝึก — ถูก Freeze เมื่อประกาศถูกซ่อน (README §5.1.2) หรือบริษัทถูกระงับ (data-schema §8.2.2)
 * `IN_PROGRESS` ขึ้นไปไม่ Freeze (ฝึกอยู่/จบแล้ว — บริษัทถูกระงับให้อาจารย์ตัดสินแทน)
 */
export const FREEZABLE_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'PENDING',
  'HR_ACCEPTED',
  'ADVISOR_PENDING',
  'ADVISOR_APPROVED',
]);

/** สถานะประกาศที่ใบสมัครต้อง Freeze (README §5.1.2: `VERIFYING` / `PENDING_REVIEW` / `SUSPENDED`) */
export const JOB_FROZEN_STATUSES = ['VERIFYING', 'PENDING_REVIEW', 'SUSPENDED'] as const;

const statusIn = (statuses: readonly string[]) => Prisma.sql`a.status::text IN (${Prisma.join([...statuses])})`;

/** Freeze ใบที่ค้างตามเงื่อนไข (เฉพาะที่ยังไม่ frozen — Freeze ซ้อนไม่รีเซ็ตเวลาเริ่ม) */
export async function freezeApplications(tx: Tx, scope: Prisma.Sql, at: Date): Promise<number> {
  return tx.$executeRaw`
    UPDATE applications a
    SET frozen = true, frozen_at = ${at}::timestamptz, version = a.version + 1
    WHERE ${scope} AND ${statusIn(FREEZABLE_STATUSES)} AND a.frozen = false`;
}

/**
 * Unfreeze + สะสมเวลา (`at − frozen_at`) ลง `sla_paused_seconds`
 * `stillFrozenIf` = เงื่อนไขที่ยังต้อง Freeze ต่อ (เช่น ประกาศกลับมาแต่บริษัทยังถูกระงับ) ⇒ ไม่ปลด
 */
export async function unfreezeApplications(tx: Tx, scope: Prisma.Sql, at: Date, stillFrozenIf: Prisma.Sql): Promise<number> {
  return tx.$executeRaw`
    UPDATE applications a
    SET frozen = false,
        sla_paused_seconds = a.sla_paused_seconds
          + GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (${at}::timestamptz - COALESCE(a.frozen_at, ${at}::timestamptz)))))::int,
        frozen_at = NULL,
        version = a.version + 1
    WHERE ${scope} AND a.frozen = true AND NOT (${stillFrozenIf})`;
}

/** ยังต้อง Freeze เพราะบริษัทถูกระงับ */
export const COMPANY_SUSPENDED = Prisma.sql`EXISTS (
  SELECT 1 FROM company_snapshots c WHERE c.company_id = a.company_id AND c.status = 'SUSPENDED')`;

/** ยังต้อง Freeze เพราะประกาศอยู่ในสถานะที่ซ่อน */
export const JOB_HIDDEN = Prisma.sql`EXISTS (
  SELECT 1 FROM job_snapshots j WHERE j.job_id = a.job_id AND j.status::text IN (${Prisma.join([...JOB_FROZEN_STATUSES])}))`;
