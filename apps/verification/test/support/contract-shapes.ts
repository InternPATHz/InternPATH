import type {
  AuditLogEntry,
  CompanyFlagItem,
  PageMeta,
  QueueItemDetail,
  QueueItemSummary,
  QueueReportEntry,
  QueueReviewReportEntry,
  QueueReviewView,
  ReportCreatedResponse,
  SetCompanyFlagResponse,
} from '@internpath/contracts';
import { expect } from 'chai';

/**
 * ตรวจ "รูปร่าง" response จริงเทียบกับชนิดใน libs/contracts (เดิมตรวจได้แค่ตอนคอมไพล์ฝั่งผู้เรียก)
 *
 * `ShapeSpec<T>` บังคับให้ระบุ **ทุกคีย์ของ T** (ขาด/เกินคีย์ ⇒ คอมไพล์ไม่ผ่าน) จึงผูกกับ contracts โดยตรง:
 * เพิ่มฟิลด์ใน contracts แล้วลืมแก้ spec ⇒ test ไม่ build; Service คืนฟิลด์เกิน/ขาด/ชนิดผิด ⇒ test ล้ม
 * ค่าของแต่ละคีย์คือชนิด JSON ที่ยอมรับ (`'absent'` = คีย์ที่เป็น optional ใน contracts และอาจไม่มี)
 */
export type Kind = 'string' | 'number' | 'boolean' | 'null' | 'array' | 'object' | 'absent';
export type ShapeSpec<T> = { [K in keyof T]-?: Kind | Kind[] };

const kindOf = (v: unknown): Kind => (v === null ? 'null' : Array.isArray(v) ? 'array' : (typeof v as Kind));

export function expectShape<T>(body: unknown, spec: ShapeSpec<T>, label = 'response'): void {
  expect(body, `${label} ต้องเป็น object`).to.be.an('object');
  const obj = body as Record<string, unknown>;
  const allowed = Object.keys(spec);
  expect(Object.keys(obj).filter((k) => !allowed.includes(k)), `${label}: มีคีย์ที่ contracts ไม่รู้จัก`).to.deep.equal([]);
  for (const [key, want] of Object.entries(spec) as Array<[string, Kind | Kind[]]>) {
    const kinds = Array.isArray(want) ? want : [want];
    if (!(key in obj)) {
      expect(kinds, `${label}: ขาดคีย์ ${key}`).to.include('absent');
      continue;
    }
    expect(kinds, `${label}.${key}: ชนิดจริง ${kindOf(obj[key])}`).to.include(kindOf(obj[key]));
  }
}

export const PAGE_META: ShapeSpec<PageMeta> = { page: 'number', page_size: 'number', total: 'number' };

export const QUEUE_ITEM_SUMMARY: ShapeSpec<QueueItemSummary> = {
  id: 'string', type: 'string', target_id: 'string', company_id: ['string', 'null'], company_name: ['string', 'null'],
  priority: 'string', due_at: 'string', overdue: 'boolean', status: 'string', created_at: 'string',
};

export const QUEUE_REPORT_ENTRY: ShapeSpec<QueueReportEntry> = {
  id: 'string', reporter_user_id: 'string', category: 'string', detail: 'string', counted: 'boolean', status: 'string', created_at: 'string',
};

export const QUEUE_REVIEW_VIEW: ShapeSpec<QueueReviewView> = {
  review_id: 'string', rating: 'number', outcome_label: 'string', title: ['string', 'null'], body: 'string', moderation_status: 'string',
};

export const QUEUE_REVIEW_REPORT_ENTRY: ShapeSpec<QueueReviewReportEntry> = { id: 'string', reporter_user_id: 'string', reason: 'string', created_at: 'string' };

export const QUEUE_ITEM_DETAIL: ShapeSpec<QueueItemDetail> = {
  ...QUEUE_ITEM_SUMMARY,
  origin: 'string', submission_id: ['string', 'null'], assigned_to: ['string', 'null'], resolution: ['string', 'null'], resolved_at: ['string', 'null'],
  content: ['object', 'null'],
  reports: 'array', review: ['object', 'null'], review_reports: 'array',
};

export const SET_COMPANY_FLAG_RESPONSE: ShapeSpec<SetCompanyFlagResponse> = { company_id: 'string', active: 'boolean', changed: 'boolean' };

export const COMPANY_FLAG_ITEM: ShapeSpec<CompanyFlagItem> = {
  company_id: 'string', company_name: ['string', 'null'], active: 'boolean', set_by: ['string', 'null'], set_reason: ['string', 'null'],
  set_at: ['string', 'null'], cleared_at: ['string', 'null'], trigger_count: ['number', 'null'],
};

export const REPORT_CREATED_RESPONSE: ShapeSpec<ReportCreatedResponse> = { id: 'string', status: 'string' };

/** `reason` เป็น `string | null` ใน Service แต่ contracts ประกาศเป็น optional — ผ่านทั้งสองแบบ จึงรับ null ด้วย */
export const AUDIT_LOG_ENTRY: ShapeSpec<AuditLogEntry> = {
  id: 'string', admin_id: 'string', action: 'string', target_type: 'string', target_id: 'string', before: ['null', 'object', 'array', 'string', 'number', 'boolean'],
  after: ['null', 'object', 'array', 'string', 'number', 'boolean'], reason: ['string', 'null', 'absent'], correlation_id: 'string', occurred_at: 'string',
};
