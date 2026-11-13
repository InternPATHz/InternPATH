// ต้องตรงกับ docs/api-contract.md §7 (Lifecycle), §8 (Notification) และ §9 (Internal) — เฉพาะที่เอกสารระบุไว้
import type { AcademicResult, ApplicationStatus, CertificateStatus } from '../enums';
import type { ProblemReportCategory } from './lifecycle-responses';

// ---- 7.2 นักศึกษา ----
export interface CreateApplicationRequest {
  job_id: string;
  resume_id: string;
  cover_letter?: string;
  consent: true;
}

export interface MyApplicationsQuery {
  status?: ApplicationStatus;
}

export interface ApplicationEligibilityResponse {
  can_apply: boolean;
  blocked_reason?: string;
}

export interface ReasonRequest {
  reason: string;
}

export interface DisputeFailRequest {
  statement: string;
}

export interface CreateProblemReportRequest {
  category: ProblemReportCategory;
  detail: string;
}

// ---- 7.3 HR ----
export interface HrApplicationsQuery {
  job_id?: string;
  status?: ApplicationStatus;
}

/** ห่าง ≥ 30 วัน (YYYY-MM-DD) */
export interface HrAcceptRequest {
  start_date: string;
  end_date: string;
}

export interface HrRejectRequest {
  reason?: string;
}

export interface HrStartRequest {
  actual_start_date: string;
  start_date?: string;
  end_date?: string;
}

export interface HrStartResponse {
  /** เมื่อฝึก < 30 วัน */
  warning?: 'NO_CERTIFICATE_ELIGIBLE';
}

export interface HrTerminateRequest {
  reason: string;
  actual_end_date?: string;
}

/** `reason` บังคับเมื่อ FAIL */
export interface HrEvaluateRequest {
  result: 'PASS' | 'FAIL';
  reason?: string;
  note?: string;
}

// ---- 7.4 อาจารย์ ----
export interface AdvisorApplicationsQuery {
  status?: ApplicationStatus;
}

export type AdvisorDisputeAction = 'request-reevaluation' | 'uphold-fail';

/** ห้ามเปลี่ยน FAIL ของบริษัทเป็น PASS (FAIL → ได้เฉพาะ ACADEMIC_FAIL / REPEAT_REQUIRED) */
export interface AcademicResultRequest {
  academic_result: AcademicResult;
  note?: string;
}

export type ProblemReportAction = 'acknowledge' | 'resolve';

export interface ResolveProblemReportRequest {
  note: string;
  follow_up_action?: 'MONITOR_COMPANY' | 'TERMINATE' | 'ESCALATE_COMPANY_REVIEW';
}

// ---- 7.5 Certificate ----
export interface PublicCertificateResponse {
  status: CertificateStatus;
  holder_name: string;
  company_name: string;
  job_title: string;
  period: { start: string; end: string };
}

// ---- 7.6 รีวิว ----
export interface CreateReviewRequest {
  rating: 1 | 2 | 3 | 4 | 5;
  title?: string;
  body: string;
  anonymous: boolean;
}

export interface CreateReviewResponse {
  status: 'SUBMITTED';
}

// ---- 7.7 Admin ----
export interface ReapplyUnlockRequest {
  reason: string;
}

// ---- 8 Notification ----
export interface NotificationsQuery {
  unread?: boolean;
}

// ---- 9 Internal (lifecycle) ----
export interface ReservationCheckRequest {
  application_ids: string[];
}

export type ReservationCheckResponse = Array<{ application_id: string; should_hold_quota: boolean }>;
