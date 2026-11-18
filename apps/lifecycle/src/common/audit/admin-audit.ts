import type { AuditLogEntry } from '@internpath/contracts';
import { Prisma, type AdminAuditLog } from '../../../generated/client';
import type { Tx } from '../../prisma/types';

/**
 * ชื่อ `action` ใน `admin_audit_log` ของ Lifecycle (README §5.10 — ทุกการกระทำของ Admin)
 * ใช้เป็นค่ากรอง `?action=` ของ `GET /admin/lifecycle/audit-logs` ด้วย
 */
export const AUDIT_ACTIONS = Object.freeze({
  CERTIFICATE_REVOKE: 'CERTIFICATE_REVOKE',
  APPLICATION_CONFIRM_NO_EVALUATION: 'APPLICATION_CONFIRM_NO_EVALUATION',
  APPLICATION_TERMINATE: 'APPLICATION_TERMINATE',
  REAPPLY_UNLOCK: 'REAPPLY_UNLOCK',
});
export type AuditAction = (typeof AUDIT_ACTIONS)[keyof typeof AUDIT_ACTIONS];

/** `target_type` ของ Lifecycle — `STUDENT` = `target_id` เป็น `user_id` ของนักศึกษา (ปลดล็อกสมัครซ้ำ) */
export type AuditTargetType = 'APPLICATION' | 'CERTIFICATE' | 'STUDENT';

export interface AdminAuditEntry {
  adminId: string;
  action: AuditAction;
  targetType: AuditTargetType;
  targetId: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  reason?: string | null;
  correlationId: string;
  occurredAt: Date;
}

/**
 * เขียน `admin_audit_log` ใน Transaction เดียวกับการเปลี่ยนข้อมูล (append-only — trigger ใน migration 1.1)
 * ผู้กระทำ เป้าหมาย ค่าก่อน-หลัง เหตุผล (README §5.10) • ห้ามใส่ข้อความรีวิว/เนื้อหาเรซูเม่/ข้อมูลส่วนบุคคลใน before/after
 */
export async function recordAdminAudit(tx: Pick<Tx, 'adminAuditLog'>, entry: AdminAuditEntry): Promise<void> {
  await tx.adminAuditLog.create({
    data: {
      adminId: entry.adminId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      before: (entry.before ?? Prisma.DbNull) as Prisma.InputJsonValue,
      after: (entry.after ?? Prisma.DbNull) as Prisma.InputJsonValue,
      reason: entry.reason ?? null,
      correlationId: entry.correlationId,
      occurredAt: entry.occurredAt,
    },
  });
}

/** แถว `admin_audit_log` ⇒ `AuditLogEntry` ของ contracts (รูปเดียวกับ `/admin/audit` ของ Verification) */
export function toAuditLogEntry(row: AdminAuditLog): AuditLogEntry {
  return {
    id: row.id,
    admin_id: row.adminId,
    action: row.action,
    target_type: row.targetType,
    target_id: row.targetId,
    before: row.before ?? null,
    after: row.after ?? null,
    ...(row.reason ? { reason: row.reason } : {}),
    correlation_id: row.correlationId,
    occurred_at: row.occurredAt.toISOString(),
  };
}
