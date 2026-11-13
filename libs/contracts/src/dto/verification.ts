// ต้องตรงกับ docs/api-contract.md §6 (Verification) — เฉพาะที่เอกสารระบุไว้
import type { QueueItemStatus, QueueItemType, RiskLevel } from '../enums';

// ---- 6.1 Admin Queue ----
export interface AdminQueueQuery {
  type?: QueueItemType;
  priority?: 'NORMAL' | 'FAST_TRACK';
  risk_level?: RiskLevel;
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
  risk_level: RiskLevel | null;
  is_appeal: boolean;
  due_at: string;
  overdue: boolean;
  status: QueueItemStatus;
  created_at: string;
}

export interface QueueHighlight {
  field: string;
  start: number;
  end: number;
  keyword: string;
  /** true = คำอยู่ในประโยคปฏิเสธ */
  negated: boolean;
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

/** รายละเอียดจาก GET /admin/queue/{id} (ตรงกับ `QueueDetail` ใน apps/verification) */
export interface QueueItemDetail extends QueueItemSummary {
  /** ที่มาของรายการ เช่น EVALUATION, VERIFY_TIMEOUT, APPEAL, REPORT_THRESHOLD, REPORT_UNCOUNTED, REJECTION_THRESHOLD */
  origin: string;
  submission_id: string | null;
  assigned_to: string | null;
  resolution: string | null;
  resolved_at: string | null;
  risk_score: number | null;
  reasons: Array<{ code: string; detail: string; matched_text?: string }>;
  /** ข้อความที่สแกนหลัง normalize; Fail-safe ที่ยังไม่มีผลตรวจ = null */
  content: Record<string, string> | null;
  highlights: QueueHighlight[];
  appeal_statement: string | null;
  /** เฉพาะ JOB_REPORT — ชนิดอื่นเป็น [] */
  reports: QueueReportEntry[];
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

// ---- 6.3 Blacklist & กฎ ----
export type BlacklistSeverity = 'HARD' | 'SOFT';

export interface BlacklistListQuery {
  severity?: BlacklistSeverity;
  enabled?: boolean;
  q?: string;
  page?: number;
  page_size?: number;
}

/** `HARD` ห้ามมี weight; `SOFT` ต้องมี weight เป็นจำนวนเต็ม ≥ 0; term ซ้ำ (ไม่สนตัวพิมพ์) ⇒ 409 TERM_EXISTS */
export interface CreateBlacklistTermRequest {
  term: string;
  severity: BlacklistSeverity;
  weight?: number;
  category?: string;
}

export interface UpdateBlacklistTermRequest {
  enabled?: boolean;
  weight?: number;
  category?: string;
}

export interface BlacklistTestRequest {
  text: string;
}

export interface BlacklistTestResponse {
  decision: string;
  risk_level: RiskLevel;
  risk_score: number;
  matched_keywords: unknown[];
  reasons: Array<{ code: string; detail: string; matched_text?: string }>;
}

export interface RiskRule {
  code: string;
  weight: number;
  params: Record<string, unknown>;
  enabled: boolean;
}

export interface NegationCue {
  id: string;
  cue: string;
  enabled: boolean;
}

export interface RiskRulesResponse {
  rules: RiskRule[];
  negation_cues: NegationCue[];
}

/** ตรวจทุกรายการก่อนแก้ (ผิดข้อเดียว = ไม่เปลี่ยนเลย 400); `NEGATION_WINDOW.params.max_gap` 0–100 */
export interface UpdateRiskRulesRequest {
  rules?: Array<{ code: string; weight?: number; params?: Record<string, unknown>; enabled?: boolean }>;
  negation_cues?: Array<{ cue: string; enabled: boolean }>;
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

export interface ReportReviewRequest {
  reason: string;
}

// ---- 6.5 ผลตรวจสำหรับ HR ----
export interface VerificationResultResponse {
  risk_level: RiskLevel;
  risk_score: number;
  reasons: Array<{ code: string; detail: string; matched_text?: string }>;
  matched_keywords: Array<{ term: string; field: string; negated: boolean }>;
  is_appeal: boolean;
  can_appeal: boolean;
  /** เมื่อ Admin เป็นผู้ปฏิเสธ */
  admin_reason?: string;
}

/** `statement` 20–2000 ตัวอักษร */
export interface AppealRequest {
  statement: string;
}

export interface AppealResponse {
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
  /** เช่น QUEUE_APPROVE, QUEUE_REJECT, BLACKLIST_CREATE|UPDATE|DELETE, RISK_RULES_UPDATE */
  action: string;
  target_type: string;
  target_id: string;
  before: unknown;
  after: unknown;
  reason?: string;
  correlation_id: string;
  occurred_at: string;
}
