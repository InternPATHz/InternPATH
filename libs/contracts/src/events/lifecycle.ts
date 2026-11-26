// ต้องตรงกับ docs/event-contract.md (E08, E09, E11-E14, E17) — ฟิลด์ snake_case ตามเอกสาร
// ผู้ส่ง: lifecycle
import type { ApplicationStatus, TerminatedBy } from '../enums';

export type ActorRole = 'STUDENT' | 'COMPANY_HR' | 'ADVISOR' | 'PLATFORM_ADMIN' | 'SYSTEM';

/** E08 `ApplicationStatusChanged` (lifecycle → notification) */
export interface ApplicationStatusChangedPayload {
  application_id: string;
  job_id: string;
  company_id: string;
  student_user_id: string;
  advisor_user_id?: string;
  /** ผู้รับแจ้งฝั่งบริษัท (ถ้าเจาะจง) */
  hr_user_ids?: string[];
  /** ไม่มีเมื่อสร้างใบสมัคร (`to_status = PENDING`) — ห้ามใส่ค่าหลอก */
  from_status?: ApplicationStatus;
  to_status: ApplicationStatus;
  /** ไม่มี = SYSTEM */
  actor_user_id?: string;
  actor_role: ActorRole;
  reason?: string;
  terminated_by?: TerminatedBy;
  entity_version: number;
  changed_at: string;
}

/** E09 `ReviewSubmitted` (lifecycle → verification) — สแกน Blacklist + ข้อมูลติดต่อส่วนตัว */
export interface ReviewSubmittedPayload {
  review_id: string;
  application_id: string;
  /** เจ้าของรีวิว (user_id) — Verification ส่งต่อใน E10 เพื่อให้ Notification แจ้งนักศึกษา */
  student_user_id: string;
  company_id: string;
  content: { title?: string; body: string };
  rating: 1 | 2 | 3 | 4 | 5;
  outcome_label: 'PASS' | 'FAIL' | 'TERMINATED' | 'NO_EVALUATION';
  submitted_at: string;
}

/** E11 `ReviewPublished` (lifecycle → identity, notification) — สถิติรวมแบบ absolute ไม่ใช่ delta */
export interface ReviewPublishedPayload {
  review_id: string;
  company_id: string;
  /**
   * `PUBLISHED` = รีวิวเพิ่งเผยแพร่; `REMOVED` = Admin ถอดรีวิวที่เผยแพร่แล้ว (`ADMIN_REMOVE`) — PM ตัดสิน 2026-11-22
   * ผู้รับที่ได้ event ไม่มีฟิลด์นี้ (ส่งก่อนเพิ่ม) ให้ถือเป็น `PUBLISHED`
   */
  change: 'PUBLISHED' | 'REMOVED';
  rating: number;
  /** จำนวนรีวิวที่เผยแพร่รวมของบริษัท หลังรวมรีวิวนี้ */
  company_review_count: number;
  /** ผลรวมคะแนน (Identity คำนวณค่าเฉลี่ยเอง) */
  company_rating_sum: number;
  /** เวอร์ชันของ "ชุดสถิติบริษัท" ที่ Lifecycle นับ */
  entity_version: number;
  published_at: string;
}

/** E12 `CertificateIssued` (lifecycle → notification) */
export interface CertificateIssuedPayload {
  certificate_id: string;
  application_id: string;
  student_user_id: string;
  company_id: string;
  issued_by_user_id: string;
  issued_at: string;
}

/** E13 `CertificateRevoked` (lifecycle → notification) */
export interface CertificateRevokedPayload {
  certificate_id: string;
  application_id: string;
  student_user_id: string;
  revoked_by_user_id: string;
  revoked_by_role: 'COMPANY_HR' | 'PLATFORM_ADMIN';
  reason: string;
  revoked_at: string;
}

/**
 * `reminder_type` ตาม README 5.3 — `EXPIRED` ไม่ส่งเป็น `ReminderDue`
 * (เป็นการเปลี่ยนสถานะแล้วส่ง `ApplicationStatusChanged`)
 */
export type ReminderType =
  | 'HR_RESPOND_PENDING_D3'
  | 'HR_RESPOND_PENDING_D7'
  | 'STUDENT_CONFIRM_D3'
  | 'ADVISOR_APPROVE_D3'
  | 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7'
  | 'HR_START_CONFIRM_ON_START'
  | 'HR_START_CONFIRM_D3'
  | 'START_CONFIRM_ESCALATE_D7'
  | 'HR_EVALUATE_D3'
  | 'EVALUATE_ESCALATE_D14'
  | 'HR_ISSUE_CERT_D3'
  | 'ISSUE_CERT_ESCALATE_D14'
  | 'ADVISOR_DISPUTE_D3'
  | 'DISPUTE_ESCALATE_D7'
  /** แจ้งอาจารย์/นักศึกษาว่าบริษัทถูกระงับขณะฝึก ต้องตัดสิน continue/terminate (ไม่ใช่การเตือนตามเวลา) */
  | 'COMPANY_SUSPENDED_DECISION';

/** E14 `ReminderDue` (lifecycle → notification) */
export interface ReminderDuePayload {
  reminder_type: ReminderType;
  entity_type: 'APPLICATION' | 'CERTIFICATE' | 'PROBLEM_REPORT';
  entity_id: string;
  /** YYYY-MM-DD (Asia/Bangkok) — ส่วนหนึ่งของ unique key ใน reminder_log */
  due_date: string;
  audience: Array<{ user_id: string; role: string }>;
  context: { application_id?: string; days_overdue?: number; deadline_at?: string };
}

/** E19 `ConductReportCreated` (lifecycle → notification) — HR รายงานพฤติกรรมนักศึกษาถึงอาจารย์ (ไม่มีรายละเอียดใน Event) */
export interface ConductReportCreatedPayload {
  conduct_report_id: string;
  application_id: string;
  student_user_id: string;
  advisor_user_id: string;
  company_id: string;
  category: string;
  created_at: string;
}

/** E17 `ProblemReportCreated` (lifecycle → notification) — ห้ามแจ้ง HR/บริษัท (README 5.2.2) */
export interface ProblemReportCreatedPayload {
  problem_report_id: string;
  application_id: string;
  student_user_id: string;
  advisor_user_id: string;
  category: string;
  created_at: string;
}
