// ต้องตรงกับ docs/event-contract.md (E05, E06, E07, E15, E16) — ผู้ส่ง: identity
import type { AdvisorLinkStatus } from '../enums';

/** E06 `CompanyEntitlementChanged` (identity → job, verification) */
export interface CompanyEntitlementChangedPayload {
  company_id: string;
  featured_enabled: boolean;
  fast_track_enabled: boolean;
  entity_version: number;
  changed_at: string;
}

/** E07 `AdvisorLinkChanged` (identity → lifecycle, notification) — Lifecycle ย้าย advisor_id ของใบสมัครที่ยังไม่สิ้นสุดเมื่อ `LINKED` */
export interface AdvisorLinkChangedPayload {
  student_user_id: string;
  old_advisor_id?: string;
  new_advisor_id?: string;
  link_status: Exclude<AdvisorLinkStatus, 'NONE'> | 'UNLINKED';
  changed_by: 'STUDENT' | 'ADVISOR' | 'ADMIN';
  entity_version: number;
  changed_at: string;
}

/** E15 `UserDeletionRequested` (identity → lifecycle, job, verification, notification) */
export interface UserDeletionRequestedPayload {
  user_id: string;
  role: string;
  company_id?: string;
  requested_at: string;
  mode: 'DELETE_AND_ANONYMIZE';
  /** รหัสนิรนามที่ทุก Service ใช้แทน actor_id ใน status_history / admin_audit_log (README 5.11) */
  anonymous_actor_id: string;
}

/** E16 `UserSuspended` (identity → gateway, notification) — `suspended=false` = ถอดออกจาก Denylist */
export interface UserSuspendedPayload {
  user_id: string;
  suspended: boolean;
  reason?: string;
  entity_version: number;
  at: string;
}

/** E05 `CompanyStatusChanged` (identity → job, lifecycle, verification, notification) */
export interface CompanyStatusChangedPayload {
  company_id: string;
  status: 'PENDING' | 'NEED_MORE_INFO' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  previous_status?: string;
  snapshot: { name: string; logo_key?: string; university_partner: boolean; verified_badge: boolean };
  owner_user_id?: string;
  reason?: string;
  entity_version: number;
  changed_at: string;
}
