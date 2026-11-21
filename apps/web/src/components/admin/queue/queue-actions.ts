import type { QueueItemType } from '@internpath/contracts';

export type QueueActionSpec = {
  action: string;
  label: string;
  /** true = ต้องกรอกเหตุผลก่อนกด (ตรงกับ api-contract §6.1) */
  reasonRequired: boolean;
  tone: 'primary' | 'danger' | 'neutral';
};

/** การตัดสินที่ทำได้ของแต่ละชนิดรายการ — ตรงกับ endpoint `/admin/queue/{id}/actions/{action}` ใน api-contract §6.1 */
export const ACTIONS_BY_TYPE: Record<QueueItemType, QueueActionSpec[]> = {
  JOB_REVIEW: [
    { action: 'approve', label: 'อนุมัติประกาศ', reasonRequired: false, tone: 'primary' },
    { action: 'reject', label: 'ปฏิเสธประกาศ', reasonRequired: true, tone: 'danger' },
  ],
  JOB_REPORT: [
    { action: 'dismiss-report', label: 'ยกเลิกรายงาน (ไม่พบความผิด)', reasonRequired: false, tone: 'neutral' },
    { action: 'uphold-report', label: 'ยืนยันรายงาน (พบความผิด)', reasonRequired: false, tone: 'danger' },
  ],
  REVIEW_REPORT: [
    { action: 'publish-review', label: 'คงรีวิวไว้ (ไม่พบความผิด)', reasonRequired: false, tone: 'primary' },
    { action: 'remove-review', label: 'ลบรีวิว', reasonRequired: true, tone: 'danger' },
  ],
  COMPANY_ACCOUNT: [
    { action: 'company-clear-flag', label: 'เคลียร์ธง UNDER_REVIEW', reasonRequired: false, tone: 'primary' },
  ],
};

export const REASON_MAX = 500;
