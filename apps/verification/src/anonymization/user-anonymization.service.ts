import type { EventEnvelope, UserDeletionRequestedPayload } from '@internpath/contracts';
import { isUuid } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/types';

@Injectable()
export class UserAnonymizationService {
  /**
   * E15 `UserDeletionRequested` (README 5.11): ทำให้ข้อมูลของผู้ใช้ใน verification_db ไม่ระบุตัวตน
   * ทุกอย่างอยู่ใน Transaction ของ EventConsumer (พร้อมบันทึก processed_events) จึงรับซ้ำได้ปลอดภัย:
   * รอบสองไม่พบ user_id เดิมแล้ว ไม่มีแถวให้แก้
   *
   * - `status_history` / `admin_audit_log`: แทน actor ด้วย `anonymous_actor_id` ภายใต้ Authorized Anonymization
   *   Operation (data-schema §2.3) — ตั้ง setting แบบ local ซึ่งหมดอายุเมื่อ Transaction จบ
   * - `job_reports`: เก็บแถว/สถานะ/ผลต่อตัวนับไว้ (ไม่ให้ตัวนับและเกณฑ์ระงับเพี้ยน) แต่เปลี่ยนผู้รายงานเป็นรหัสนิรนาม
   *   และล้าง `detail` ทุกสถานะ (PM ตัดสิน 2026-11-15); ลบ `reporter_stats`
   * - id ของ Admin ในตารางอื่นเปลี่ยนเป็นรหัสนิรนาม ยกเว้น `queue_items.assigned_to` ของรายการที่ยังไม่ปิด
   *   ซึ่งปลดเป็น NULL เพื่อให้ Admin คนอื่นรับงานต่อได้ (รายการที่ปิดแล้วเก็บเป็นรหัสนิรนาม)
   *
   * ห้าม log payload/ข้อความรายงาน — ใช้ event_id เท่านั้น
   */
  async handleUserDeletionRequested(
    env: EventEnvelope<'UserDeletionRequested', UserDeletionRequestedPayload>,
    tx: Tx,
  ): Promise<void> {
    const { user_id: userId, anonymous_actor_id: anonymous } = env.payload;
    if (typeof userId !== 'string' || !isUuid(userId) || typeof anonymous !== 'string' || !isUuid(anonymous) || anonymous === userId) {
      throw new Error(`Invalid UserDeletionRequested payload (event ${env.event_id})`);
    }

    // อนุญาตให้ trigger ยอมรับการแทนที่ actor ใน Transaction นี้เท่านั้น (is_local = true)
    await tx.$executeRaw`SELECT set_config('internpath.anonymize', 'on', true), set_config('internpath.anonymous_actor_id', ${anonymous}, true)`;
    await tx.statusHistory.updateMany({ where: { actorId: userId }, data: { actorId: anonymous } });
    await tx.adminAuditLog.updateMany({ where: { adminId: userId }, data: { adminId: anonymous } });

    await tx.jobReport.updateMany({ where: { reporterUserId: userId }, data: { reporterUserId: anonymous, detail: '' } });
    await tx.reporterStat.deleteMany({ where: { userId } });

    await tx.appeal.updateMany({ where: { decidedBy: userId }, data: { decidedBy: anonymous } });
    await tx.blacklistTerm.updateMany({ where: { createdBy: userId }, data: { createdBy: anonymous } });
    await tx.riskRule.updateMany({ where: { updatedBy: userId }, data: { updatedBy: anonymous } });
    await tx.companyFlag.updateMany({ where: { clearedBy: userId }, data: { clearedBy: anonymous } });
    await tx.queueItem.updateMany({ where: { assignedTo: userId, status: { not: 'RESOLVED' } }, data: { assignedTo: null } });
    await tx.queueItem.updateMany({ where: { assignedTo: userId, status: 'RESOLVED' }, data: { assignedTo: anonymous } });
  }
}
