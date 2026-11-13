// Response ที่ api-contract.md เดิมไม่ได้ระบุฟิลด์ — PM ตัดสินจาก data-schema.md (2026-11-14)
// กฎ: ไม่ส่ง object_key (ใช้ Signed URL ~10 นาที); HR ห้ามเห็น problem_reports
import type {
  AcademicResult,
  ApplicationStatus,
  CertificateStatus,
  JobStatus,
  ProblemReportStatus,
  ReviewStatus,
  TerminatedBy,
} from '../enums';

// ---- 7.1 โปรไฟล์/เรซูเม่ ----
/** GET/PUT /me/profile */
export interface StudentProfile {
  headline?: string;
  skills: string[];
  bio?: string;
  portfolio_url?: string;
  major: string;
  year_level: number;
}

/** GET /me/resumes */
export interface ResumeItem {
  id: string;
  size_bytes: number;
  is_primary: boolean;
  /** Signed URL ~10 นาที */
  url: string;
  uploaded_at: string;
}

/** GET /hr/applications/{id}/resume, GET /advisor/applications/{id}/resume */
export interface ResumeUrlResponse {
  url: string;
  expires_at: string;
}

// ---- 7.2-7.4 ใบสมัคร ----
export interface ApplicationTimelineEntry {
  from_status?: ApplicationStatus;
  to_status: ApplicationStatus;
  actor_role: string;
  reason?: string;
  occurred_at: string;
}

/** ชื่อปุ่มที่กดได้ — ตรงกับ `{action}` ใน endpoint (api-contract §7) */
export type ApplicationAction = string;

export interface ApplicationBase {
  id: string;
  job_id: string;
  job_title: string;
  company_id: string;
  company_name: string;
  status: ApplicationStatus;
  major_mismatch: boolean;
  start_date?: string;
  end_date?: string;
  actual_start_date?: string;
  actual_end_date?: string;
  frozen: boolean;
  status_changed_at: string;
  created_at: string;
}

/** POST /applications (201) และรายการ GET /me/applications */
export type StudentApplicationItem = ApplicationBase;

/** GET /me/applications/{id} — รวม timeline (จาก status_history) และปุ่มที่กดได้ */
export interface StudentApplicationDetail extends ApplicationBase {
  cover_letter?: string;
  terminated_by?: TerminatedBy;
  terminate_reason?: string;
  academic_result?: AcademicResult;
  timeline: ApplicationTimelineEntry[];
  available_actions: ApplicationAction[];
}

/** รายการ GET /hr/applications */
export interface HrApplicationItem extends ApplicationBase {
  student_user_id: string;
}

/** GET /hr/applications/{id} — เห็นโปรไฟล์ได้เฉพาะที่ได้รับ Consent */
export interface HrApplicationDetail extends HrApplicationItem {
  cover_letter?: string;
  profile?: StudentProfile & { full_name: string };
  available_actions: ApplicationAction[];
  /** เมื่อนักศึกษา confirm ที่อื่นอยู่ ⇒ ไม่มี `accept` */
  accept_blocked_reason?: string;
}

/** รายการ GET /advisor/applications */
export interface AdvisorApplicationItem extends ApplicationBase {
  student_user_id: string;
  student_name: string;
  flagged_for_advisor: boolean;
}

/** GET /advisor/students/{id}/overview */
export interface AdvisorStudentOverview {
  student_user_id: string;
  full_name: string;
  applications: ApplicationBase[];
}

// ---- รายงานปัญหาระหว่างฝึก ----
/** ค่า category ของรายงานปัญหาระหว่างฝึก (PM ตัดสิน — เพิ่มค่าต้องแก้เอกสาร) */
export type ProblemReportCategory =
  | 'WORKLOAD_OR_HOURS'
  | 'NO_ALLOWANCE_AS_PROMISED'
  | 'UNSAFE_OR_HARASSMENT'
  | 'DIFFERENT_FROM_JOB_POST'
  | 'OTHER';

/** รายการ GET /advisor/problem-reports และ /admin/lifecycle/problem-reports */
export interface ProblemReportItem {
  id: string;
  application_id: string;
  student_user_id: string;
  category: ProblemReportCategory;
  detail: string;
  status: ProblemReportStatus;
  /** คำนวณตอนอ่าน: ยังไม่ RESOLVED และเลย due_at */
  overdue: boolean;
  due_at: string;
  resolution_note?: string;
  follow_up_action?: 'MONITOR_COMPANY' | 'TERMINATE' | 'ESCALATE_COMPANY_REVIEW';
  created_at: string;
}

// ---- 7.5 Certificate ----
/** GET /me/certificates */
export interface CertificateItem {
  id: string;
  certificate_code: string;
  company_name: string;
  job_title: string;
  period: { start: string; end: string };
  actual_days: number;
  status: CertificateStatus;
  issued_at: string;
}

/** GET /me/certificates/{id}/download */
export interface CertificateDownloadResponse {
  url: string;
  expires_at: string;
}

/** GET /public/certificates/{code}/verify-hash */
export interface CertificateHashResponse {
  sha256: string;
}

// ---- 7.6 รีวิว ----
/** รายการ GET /companies/{id}/reviews (เฉพาะ PUBLISHED) */
export interface PublicReviewItem {
  id: string;
  rating: number;
  title?: string;
  body: string;
  outcome_label: 'PASS' | 'FAIL' | 'TERMINATED' | 'NO_EVALUATION';
  /** anonymous ⇒ ไม่มี reviewer_name; ใช้ display_major + display_year แทน */
  reviewer_name?: string;
  display_major?: string;
  display_year?: number;
  reply?: { body: string; created_at: string };
  published_at: string;
}

/** รายการ GET /me/reviews */
export interface MyReviewItem {
  id: string;
  application_id: string;
  company_id: string;
  rating: number;
  title?: string;
  body: string;
  anonymous: boolean;
  status: ReviewStatus;
  created_at: string;
}

/** POST /hr/reviews/{id}/reply */
export interface ReplyReviewRequest {
  body: string;
}

// ---- 7.7 Admin ----
/** GET /admin/lifecycle/no-evaluation-candidates */
export interface NoEvaluationCandidate extends ApplicationBase {
  days_since_end: number;
}

/** GET /admin/lifecycle/company-stats/{company_id} */
export interface CompanyLifecycleStats {
  company_id: string;
  rescinded_count: number;
  terminated_count: number;
}

// ---- 8 Notification ----
/** รายการ GET /notifications */
export interface NotificationItem {
  id: string;
  type: string;
  title: string;
  body: string;
  link?: string;
  read: boolean;
  created_at: string;
}

/** GET /notifications/unread-count */
export interface UnreadCountResponse {
  count: number;
}

// ---- 9 Internal (job → lifecycle) ----
/** GET /internal/v1/jobs/{job_id} */
export interface InternalJobResponse {
  job_id: string;
  company_id: string;
  status: JobStatus;
  quota: number;
  quota_available: number;
  target_majors: string[];
  application_deadline: string;
  entity_version: number;
}
