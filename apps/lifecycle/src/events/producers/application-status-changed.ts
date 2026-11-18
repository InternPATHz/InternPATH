import type { ApplicationStatus, ApplicationStatusChangedPayload, TerminatedBy } from '@internpath/contracts';
import type { Actor } from '../../state-machine/status-history.writer';

export const APPLICATION_STATUS_CHANGED = 'ApplicationStatusChanged';

/** ฟิลด์ของใบสมัครที่ใช้สร้าง E08 (หลังเปลี่ยนสถานะแล้ว) */
export interface StatusChangedSource {
  id: string;
  jobId: string;
  companyId: string;
  studentUserId: string;
  advisorUserId: string | null;
  status: ApplicationStatus;
  terminatedBy: TerminatedBy | null;
  entityVersion: number;
}

/**
 * Payload E08 ตาม event-contract.md — มีแค่ id/สถานะ **ห้ามมีข้อมูลส่วนบุคคล** (ชื่อ อีเมล ฯลฯ)
 * `actor_user_id` ไม่ใส่เมื่อเป็น SYSTEM; `hr_user_ids` ไม่ใส่ ⇒ Notification ดึงสมาชิกบริษัทจาก Identity เอง (§6.1)
 * `fromStatus = null` (สร้างใบสมัคร → `PENDING`) ⇒ ไม่ใส่ `from_status` เลย — ห้ามใส่ค่าหลอก (PM ตัดสิน 2026-11-18)
 */
export function buildApplicationStatusChanged(
  after: StatusChangedSource,
  fromStatus: ApplicationStatus | null,
  actor: Actor,
  changedAt: Date,
  options: { reason?: string | null; hrUserIds?: string[] } = {},
): ApplicationStatusChangedPayload {
  const reason = options.reason?.trim();
  return {
    application_id: after.id,
    job_id: after.jobId,
    company_id: after.companyId,
    student_user_id: after.studentUserId,
    ...(after.advisorUserId ? { advisor_user_id: after.advisorUserId } : {}),
    ...(options.hrUserIds?.length ? { hr_user_ids: [...options.hrUserIds] } : {}),
    ...(fromStatus ? { from_status: fromStatus } : {}),
    to_status: after.status,
    ...(actor.role !== 'SYSTEM' && actor.userId ? { actor_user_id: actor.userId } : {}),
    actor_role: actor.role,
    ...(reason ? { reason } : {}),
    ...(after.status === 'TERMINATED' && after.terminatedBy ? { terminated_by: after.terminatedBy } : {}),
    entity_version: after.entityVersion,
    changed_at: changedAt.toISOString(),
  };
}
