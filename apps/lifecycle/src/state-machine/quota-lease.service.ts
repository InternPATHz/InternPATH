import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * อายุ lease ของคำสั่งที่จอง/คืนโควตา — ต้องเกินเวลารวมที่ใช้เรียก Job สูงสุด:
 * `fetchInternal` timeout 3 วินาที × ลอง 3 ครั้ง + พัก ≈ 10 วินาทีต่อการเรียก และคำสั่ง accept เรียกได้ 2 ครั้ง
 * (reserve และ release ชดเชย) + Transaction จึงเผื่อไว้ 45 วินาที — หมดอายุเองถ้า process ล่มกลางทาง
 */
export const QUOTA_LEASE_MS = 45_000;

/**
 * Lease ต่อใบสมัคร (`applications.quota_op_until`) กัน **คำสั่งที่เรียกโควตาของใบเดียวกันซ้อนกัน** (QIR-01)
 *
 * ปัญหาที่แก้: accept A จองแล้ว Transaction ล้ม → release ชดเชย (ยังค้างบนเครือข่าย) ระหว่างนั้น accept B ของใบเดิม
 * จองซ้ำ (Job ตอบ 200 เพราะยัง `RESERVED`) แล้วสำเร็จ → release ของ A มาถึงทีหลังและปลดการจองของ B
 * ⇒ Lifecycle ถือโควตา (`quota_reserved = true`) แต่ Job ไม่มีการจอง
 *
 * - ผู้ถือ lease เป็นคนเดียวที่เริ่ม reserve/compensate ของใบนั้นได้ ผู้มาซ้อน ⇒ `acquire` คืน `null`
 * - คืน lease ด้วยค่า token เดิมเท่านั้น (ไม่ปลด lease ของผู้อื่นที่ยึดต่อหลังหมดอายุ)
 * - ล่ม/ค้าง ⇒ หมดอายุเอง; release เก่าที่หลุดมาหลังหมดอายุ ⇒ `QuotaRepairService` ซ่อมในรอบถัดไป
 * - เขียนด้วย SQL ตรง: ไม่แตะ `version`/`entity_version` (ไม่ใช่การเปลี่ยนสถานะและไม่ให้ชน optimistic lock)
 */
@Injectable()
export class QuotaLeaseService {
  constructor(private readonly db: PrismaService) {}

  /** คืน token ของ lease (เวลาหมดอายุ) หรือ `null` เมื่อมีผู้ถืออยู่ */
  async acquire(applicationId: string, now = new Date()): Promise<Date | null> {
    const until = new Date(now.getTime() + QUOTA_LEASE_MS);
    const rows = await this.db.$queryRaw<Array<{ id: string }>>`
      UPDATE applications SET quota_op_until = ${until}
      WHERE id = ${applicationId}::uuid AND (quota_op_until IS NULL OR quota_op_until <= ${now})
      RETURNING id`;
    return rows.length === 1 ? until : null;
  }

  /** คืน lease ที่ถืออยู่ (ล้มเหลวได้ — หมดอายุเอง จึงไม่ throw) */
  async release(applicationId: string, token: Date): Promise<void> {
    try {
      await this.db.$executeRaw`
        UPDATE applications SET quota_op_until = NULL
        WHERE id = ${applicationId}::uuid AND quota_op_until = ${token}`;
    } catch {
      // ปล่อยให้หมดอายุเอง
    }
  }
}
