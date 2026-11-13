import type { Tx } from '../prisma/types';

/**
 * ล็อกระดับ Transaction (`pg_advisory_xact_lock`) ตาม scope+id — ปล่อยเองเมื่อ commit/rollback
 * ใช้ทำให้การทำงานที่ "อ่านแล้วค่อยเขียน" ของ (ผู้ใช้ | ประกาศ) เดียวกันเรียงต่อกัน (โควตา 5/วัน, ตัวนับ/คิวรายงาน/คำตัดสิน Admin)
 * ลำดับการขอล็อกต้องเหมือนกันทุกที่เพื่อกัน deadlock: **user ก่อน job** (คำตัดสินของ Admin ขอเฉพาะ job)
 */
export async function lockScope(tx: Tx, scope: 'user' | 'job', id: string): Promise<void> {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${scope}:${id}`}, 0))::text AS locked`;
}
