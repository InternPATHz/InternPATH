// ต้องตรงกับ docs/api-contract.md §6 (Verification) — เฉพาะที่เอกสารระบุไว้
import type { QueueItemStatus, QueueItemType } from '../enums';

// ---- 6.1 Admin Queue ----
export interface AdminQueueQuery {
  type?: QueueItemType;
  priority?: 'NORMAL' | 'FAST_TRACK';
  overdue?: boolean;
  status?: QueueItemStatus;
  page?: number;
  page_size?: number;
}

/** รายการจาก GET /admin/queue (ตรงกับ `QueueListItem` ใน apps/verification) */
export interface QueueItemSummary {
  id: string;
  type: QueueItemType;
  target_id: string;
  company_id: string | null;
  company_name: string | null;
  priority: 'NORMAL' | 'FAST_TRACK';
  due_at: string;
  overdue: boolean;
  status: QueueItemStatus;
  created_at: string;
}

/** รายงานหนึ่งฉบับในรายการ JOB_REPORT — ตัวตนผู้รายงานและ `detail` เห็นได้เฉพาะ Admin ผ่าน GET /admin/queue/{id} */
export interface QueueReportEntry {
  id: string;
  reporter_user_id: string;
  category: JobReportCategory;
  detail: string;
  /** false เมื่อผู้รายงานถูกยกคำร้องติดกันครบเกณฑ์ (ไม่นับเข้าเกณฑ์ระงับ) */
  counted: boolean;
  status: 'OPEN' | 'DISMISSED' | 'UPHELD';
  created_at: string;
}

/** รีวิวในรายการ REVIEW_REPORT */
export interface QueueReviewView {
  review_id: string;
  rating: number;
  outcome_label: string;
  title: string | null;
  body: string;
  /** PASSED | ADMIN_PUBLISHED | ADMIN_REMOVED (HELD เลิกใช้) */
  moderation_status: string;
}

/** รายงานหนึ่งฉบับในรายการ REVIEW_REPORT — ตัวตนผู้รายงานและเหตุผลเห็นได้เฉพาะ Admin ผ่าน GET /admin/queue/{id} */
export interface QueueReviewReportEntry {
  id: string;
  reporter_user_id: string;
  reason: string;
  created_at: string;
}

/** รายละเอียดจาก GET /admin/queue/{id} (ตรงกับ `QueueDetail` ใน apps/verification) */
export interface QueueItemDetail extends QueueItemSummary {
  /** ที่มาของรายการ เช่น FLAGGED_COMPANY, VERIFY_TIMEOUT, REPORT_THRESHOLD, REPORT_UNCOUNTED, REJECTION_THRESHOLD, ADMIN_FLAG, REVIEW_REPORT */
  origin: string;
  submission_id: string | null;
  assigned_to: string | null;
  resolution: string | null;
  resolved_at: string | null;
  /** เนื้อหาประกาศที่ส่งมากับ E01 (หลัง normalize); Fail-safe ที่ยังไม่มี submission = null */
  content: Record<string, string> | null;
  /** เฉพาะ JOB_REPORT — ชนิดอื่นเป็น [] */
  reports: QueueReportEntry[];
  /** เฉพาะ REVIEW_REPORT — ชนิดอื่นเป็น null */
  review: QueueReviewView | null;
  /** เฉพาะ REVIEW_REPORT — ชนิดอื่นเป็น [] */
  review_reports: QueueReviewReportEntry[];
}

export type QueueJobAction = 'approve' | 'reject';
export type QueueReportAction = 'dismiss-report' | 'uphold-report';
export type QueueReviewAction = 'publish-review' | 'remove-review';

/** `reject` ต้องมี reason */
export interface QueueActionRequest {
  reason?: string;
}

// ---- 6.2 ธงบริษัท ----
/** PUT /admin/flags/companies/{company_id}/under-review — `reason` บังคับทั้งสองทิศ */
export interface SetCompanyFlagRequest {
  active: boolean;
  reason: string;
}

/** `changed=false` เมื่อค่าเดิมอยู่แล้ว (ไม่ส่ง CompanyFlagChanged) */
export interface SetCompanyFlagResponse {
  company_id: string;
  active: boolean;
  changed: boolean;
}

/** รายการจาก GET /admin/flags/companies (เฉพาะบริษัทที่เคยติดธง) */
export interface CompanyFlagItem {
  company_id: string;
  company_name: string | null;
  active: boolean;
  set_by: 'SYSTEM' | 'ADMIN' | null;
  set_reason: string | null;
  set_at: string | null;
  cleared_at: string | null;
  trigger_count: number | null;
}

export interface CompanyFlagsQuery {
  active?: boolean;
  /** ค้นชื่อบริษัท (ไม่สนตัวพิมพ์) */
  q?: string;
  page?: number;
  page_size?: number;
}

// ---- 6.4 การรายงาน ----
/** หมวดรายงานประกาศ (R5-G01: enum — PM ตัดสินค่า 2026-11-14; เพิ่มค่าต้องแก้เอกสาร) */
export type JobReportCategory =
  | 'SCAM_OR_FEE'
  | 'MISLEADING_INFO'
  | 'INAPPROPRIATE_CONTENT'
  | 'DUPLICATE_OR_SPAM'
  | 'OTHER';

/** `detail` 20–1000 ตัวอักษร; รายงานได้เมื่อประกาศเป็น PUBLISHED/CLOSED (R5-G01) */
export interface ReportJobRequest {
  category: JobReportCategory;
  detail: string;
}

/** `reason` 10–1000 ตัวอักษร; รายงานได้เฉพาะรีวิวที่เผยแพร่อยู่ (HR เฉพาะรีวิวของบริษัทตน) */
export interface ReportReviewRequest {
  reason: string;
}

/** ตอบ `201` ของ POST /jobs/{id}/reports และ POST /reviews/{id}/reports — ไม่บอกว่ารายงานนับเข้าเกณฑ์หรือไม่ */
export interface ReportCreatedResponse {
  id: string;
  status: 'OPEN';
}

// ---- 6.6 Audit ----
export interface AuditQuery {
  actor?: string;
  action?: string;
  target_type?: string;
  from?: string;
  to?: string;
  page?: number;
  page_size?: number;
}

export interface AuditLogEntry {
  id: string;
  admin_id: string;
  /** เช่น QUEUE_APPROVE, QUEUE_REJECT, REVIEW_PUBLISH|REMOVE, FLAG_SET|CLEAR */
  action: string;
  target_type: string;
  target_id: string;
  before: unknown;
  after: unknown;
  reason?: string;
  correlation_id: string;
  occurred_at: string;
}
