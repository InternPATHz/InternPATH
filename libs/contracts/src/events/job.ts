// ต้องตรงกับ docs/event-contract.md (E01-E03) — ฟิลด์ snake_case ตามเอกสาร

import type { JobStatus } from '../enums';

export type ApplicationEffect = 'FREEZE' | 'UNFREEZE' | 'CANCEL_PRE_APPROVAL' | 'FLAG_POST_APPROVAL' | 'NONE';

/** ฟิลด์ข้อความของประกาศที่ต้องสแกน (E01 content) */
export interface JobContent {
  job_title: string;
  description: string;
  responsibilities: string;
  qualifications: string;
  allowance_text: string;
  location: string;
  contact_notes?: string;
}

/** E01 `JobSubmitted` (job → verification) */
export interface JobSubmittedPayload {
  job_id: string;
  company_id: string;
  /** 1 ครั้งที่ส่งตรวจ (idempotency ของการตรวจ) */
  submission_id: string;
  submission_kind: 'NEW' | 'EDIT' | 'RESUBMIT';
  changed_fields?: string[];
  content: JobContent;
  work_mode: 'ONSITE' | 'REMOTE' | 'HYBRID';
  hours_per_week: number;
  /** `amount_thb` เป็นจำนวนเงินต่อเดือน */
  allowance: { type: 'AMOUNT' | 'NONE'; amount_thb?: number };
  company_flag_under_review: boolean;
  fast_track: boolean;
  submitted_at: string;
}

export type JobVerifiedDecision =
  | 'APPROVE'
  | 'PENDING_REVIEW'
  | 'AUTO_REJECT'
  | 'APPEAL_ACCEPTED'
  | 'ADMIN_APPROVE'
  | 'ADMIN_REJECT'
  | 'REMOVE'
  | 'RESTORE';

export interface JobVerifiedReason {
  code: string;
  detail: string;
  matched_text?: string;
}

/** E02 `JobVerified` (verification → job) */
export interface JobVerifiedPayload {
  job_id: string;
  submission_id: string;
  decision: JobVerifiedDecision;
  risk_score?: number;
  risk_level?: 'LOW' | 'MEDIUM' | 'HIGH';
  reasons: JobVerifiedReason[];
  is_appeal: boolean;
  decided_by: 'SYSTEM' | 'ADMIN';
  decided_at: string;
  /**
   * บังคับเมื่อ `decision` เป็น `REMOVE` | `RESTORE`: รายการคิวรายงานที่ตัดสิน (ค่าเดียวกับ `queue_item_id` ของ E04 ที่ระงับประกาศ)
   * Job ใช้ปิดช่องเหตุการณ์ข้ามรอบ — รับเฉพาะเมื่อตรงกับ E04 ที่ระงับอยู่ ไม่เช่นนั้นข้าม; decision อื่นไม่มีฟิลด์นี้
   */
  queue_item_id?: string;
}

/** E03 `JobStatusChanged` (job → lifecycle, notification, verification) */
export interface JobStatusChangedPayload {
  job_id: string;
  company_id: string;
  from_status: JobStatus;
  to_status: JobStatus;
  /** เช่น VERIFY_TIMEOUT (Fail-safe), REPORT_THRESHOLD, ADMIN_DISMISSED */
  reason_code?: string;
  reason?: string;
  /** ใช้กับ reason_code=VERIFY_TIMEOUT: การส่งตรวจที่หมดเวลา (Verification ต้องใช้ส่ง JobVerified ของ Admin) */
  submission_id?: string;
  entity_version: number;
  changed_at: string;
  /** คำแนะนำให้ Lifecycle (README 5.1.2) — Lifecycle เป็นผู้ตัดสินใจเปลี่ยนใบสมัครเอง */
  application_effect?: ApplicationEffect;
}
