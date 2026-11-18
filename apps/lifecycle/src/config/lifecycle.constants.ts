/** ค่าคอนฟิกกลางเริ่มต้นของ Lifecycle Service (README §5.3, §5.4, §5.7, docs/data-schema.md §6) */
export const LIFECYCLE_DEFAULTS = {
  // SLA ตอบรับและหมดอายุ (วันตามปฏิทิน Asia/Bangkok)
  SLA_PENDING_DAYS: 14,
  SLA_PENDING_REMINDER_D3: 3,
  SLA_PENDING_REMINDER_D7: 7,

  SLA_ACCEPTED_DAYS: 5,
  SLA_ACCEPTED_REMINDER_D3: 3,

  SLA_ADVISOR_PENDING_DAYS: 7,
  SLA_ADVISOR_PENDING_REMINDER_D3: 3,

  SLA_START_CONFIRM_DAYS: 14,
  SLA_START_CONFIRM_REMINDER_D3: 3,
  SLA_START_CONFIRM_ESCALATE_D7: 7,

  SLA_EVALUATION_DAYS: 14,
  SLA_EVALUATION_REMINDER_D3: 3,

  SLA_CERT_ISSUE_DAYS: 14,
  SLA_CERT_ISSUE_REMINDER_D3: 3,

  SLA_DISPUTE_DAYS: 7,
  SLA_DISPUTE_REMINDER_D3: 3,

  // กฎธุรกิจบังคับ
  CERT_MIN_ACTUAL_DAYS: 30,
  DISPUTE_WINDOW_DAYS: 7,
  PROBLEM_REPORT_SLA_HOURS: 48,

  // ความถี่ Scheduler & Reconciliation (นาที)
  SCHEDULER_INTERVAL_MINUTES: 15,
  RECONCILIATION_INTERVAL_MINUTES: 30,

  // Storage Presigned URL (~10 นาที ตาม README 5.9)
  SIGNED_URL_EXPIRES_SECONDS: 600,

  // ชั้นกันที่ Service ของหน้าตรวจใบรับรองสาธารณะ (README 5.4, 5.7 — Gateway ตั้ง 30 ครั้ง/นาที/IP เท่ากัน)
  PUBLIC_CERT_RATE_LIMIT_PER_MINUTE: 30,
} as const;

export type LifecycleConfigKey = keyof typeof LIFECYCLE_DEFAULTS;
