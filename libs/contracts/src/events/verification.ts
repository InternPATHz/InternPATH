// ต้องตรงกับ docs/event-contract.md (E04, E10, E18) — ฟิลด์ snake_case ตามเอกสาร
// ผู้ส่ง: verification

/** E04 `ReportThresholdReached` (verification → job, notification) */
export interface ReportThresholdReachedPayload {
  job_id: string;
  company_id: string;
  /** นับเฉพาะรายงานที่นับเข้าเกณฑ์ */
  report_count: number;
  /** รายการคิว Admin ที่สร้างแล้ว */
  queue_item_id: string;
  reached_at: string;
}

export interface ReviewModerationReason {
  code: 'BLACKLIST' | 'PERSONAL_CONTACT' | 'REPORTED' | 'ADMIN';
  detail?: string;
}

/** E10 `ReviewModerationResult` (verification → lifecycle, notification) — `HOLD` = พักรีวิวเข้าคิว Admin ไม่ตีกลับ */
export interface ReviewModerationResultPayload {
  review_id: string;
  decision: 'PUBLISH' | 'HOLD' | 'ADMIN_PUBLISH' | 'ADMIN_REMOVE';
  reasons: ReviewModerationReason[];
  decided_by: 'SYSTEM' | 'ADMIN';
  decided_at: string;
}

/** E18 `CompanyFlagChanged` (verification → job, notification) */
export interface CompanyFlagChangedPayload {
  company_id: string;
  flag: 'UNDER_REVIEW';
  active: boolean;
  trigger_count?: number;
  set_by: 'SYSTEM' | 'ADMIN';
  entity_version: number;
  at: string;
}
