// ต้องตรงกับ docs/api-contract.md §5 (Job) และ §9 (Internal) — เฉพาะที่เอกสารระบุไว้
import type { JobCategory, JobStatus, WorkMode } from '../enums';

/** Internal Job → Identity lookup for Directory category filtering (§9). */
export interface DirectoryCompanyIdsResponse {
  company_ids: string[];
  next_cursor: string | null;
}

/** Tag ทักษะ (api-contract §5.4) — รายการกลางที่ Admin จัดการ */
export interface JobTag {
  id: string;
  name: string;
  slug: string;
}

/** Tag สำหรับหน้า Admin (`GET /admin/tags`) */
export interface AdminTag extends JobTag {
  active: boolean;
  job_count: number;
}

export interface CreateTagRequest {
  name: string;
}

export interface UpdateTagRequest {
  name?: string;
  active?: boolean;
}

/** Job Object (ย่อ) ตาม §5.1 — ประกาศที่ส่งตรวจแล้ว (ทุกสถานะยกเว้น `DRAFT`) ฟิลด์เนื้อหาครบเสมอ; `DRAFT` ใช้ `JobDraftObject` */
export interface JobObject {
  id: string;
  company: { id: string; name: string; logo_url?: string; badges: string[] };
  category: JobCategory;
  job_title: string;
  description: string;
  responsibilities: string;
  qualifications: string;
  allowance: { type: 'AMOUNT' | 'NONE'; amount_thb?: number; text: string };
  location: string;
  work_mode: WorkMode;
  hours_per_week: number;
  period: { start: string; end: string };
  target_majors: string[];
  /** Tag ทักษะ 1–10 รายการ (เช่น NextJs, NestJs, Rust) */
  tags: JobTag[];
  quota: number;
  quota_available: number;
  application_deadline: string;
  status: Exclude<JobStatus, 'DRAFT'>;
  featured: boolean;
  published_at?: string;
}

/**
 * ประกาศสถานะ `DRAFT` — HR สร้างได้แม้กรอกไม่ครบ (data-schema §4: ฟิลด์เนื้อหา/โครงสร้างเป็น nullable; ตรวจความครบตอน `actions/submit`)
 * ปรากฏเฉพาะมุมมอง HR (`POST /hr/jobs`, `GET /hr/jobs`, `GET /hr/jobs/{id}`, `PATCH /hr/jobs/{id}`) — ไม่ปรากฏในหน้าสาธารณะ/Search/Internal
 */
export interface JobDraftObject {
  id: string;
  company: JobObject['company'];
  category: JobCategory | null;
  job_title: string | null;
  description: string | null;
  responsibilities: string | null;
  qualifications: string | null;
  allowance: { type: 'AMOUNT' | 'NONE'; amount_thb?: number; text?: string } | null;
  location: string | null;
  work_mode: WorkMode | null;
  hours_per_week: number | null;
  period: { start: string | null; end: string | null };
  target_majors: string[] | null;
  /** DRAFT ยังไม่มี Tag ได้ (ว่าง = []) */
  tags: JobTag[];
  quota: number | null;
  /** `quota` ว่างอยู่ ⇒ null */
  quota_available: number | null;
  application_deadline: string | null;
  status: 'DRAFT';
  featured: boolean;
}

/** ประกาศในมุมมอง HR/Admin: ครบ (`JobObject`) หรือ DRAFT ไม่ครบ (`JobDraftObject`) แยกด้วย `status` */
export type HrJobObject = JobObject | JobDraftObject;

export interface HrJobsQuery {
  status?: JobStatus;
}

/** ส่วนเพิ่มของมุมมอง HR/Admin (ไม่แสดงในหน้าสาธารณะ) */
export interface HrJobExtras {
  contact_notes?: string;
  admin_reason?: string;
  suspended_from_status?: JobStatus;
}

/**
 * GET /hr/jobs/{id} = Job Object (หรือ `JobDraftObject` เมื่อ `DRAFT`) + มุมมอง HR/Admin
 * เหตุผลที่ Admin ปฏิเสธ (`ADMIN_REJECTED`) แสดงจาก `GET /hr/jobs/{id}` ผ่านฟิลด์ `HrJobExtras.admin_reason` (ปรับ 2026-11-21: ตัดผลตรวจอัตโนมัติและอุทธรณ์)
 */
export type HrJobDetail = HrJobObject & HrJobExtras;

/** ฟิลด์ที่ HR แก้ได้ของประกาศ (api-contract §5.1) — ฟิลด์ที่ต้องครบก่อน `submit` ดู data-schema §4 */
export interface JobWritableFields {
  category: JobCategory;
  job_title: string;
  description: string;
  responsibilities: string;
  qualifications: string;
  allowance: { type: 'AMOUNT' | 'NONE'; amount_thb?: number; text?: string };
  location: string;
  contact_notes: string;
  work_mode: WorkMode;
  hours_per_week: number;
  period: { start: string; end: string };
  target_majors: string[];
  /** id ของ Tag ทักษะ 1–10 รายการ (ต้องครบตอน `submit`) */
  tag_ids: string[];
  quota: number;
  application_deadline: string;
}

/** POST /hr/jobs — ทุกฟิลด์ไม่บังคับ (DRAFT ไม่ครบได้ ตรวจครบตอน `submit`) */
export type CreateJobRequest = Partial<JobWritableFields>;

/** PATCH /hr/jobs/{id} — ส่งเฉพาะฟิลด์ที่แก้ */
export type UpdateJobRequest = Partial<JobWritableFields>;

/** PATCH /hr/jobs/{id} — Job Object (มุมมอง HR) + `requires_reverification` */
export type UpdateJobResponse = HrJobDetail & { requires_reverification: boolean };

export type HrJobAction = 'submit' | 'close' | 'reopen';

export interface SetFeaturedRequest {
  enabled: boolean;
}

export interface SearchJobsQuery {
  q?: string;
  category?: JobCategory;
  work_mode?: WorkMode;
  major?: string;
  /** slug ของ Tag คั่นด้วยจุลภาค — ประกาศที่มี Tag ใดก็ได้ (any-of) */
  tags?: string;
  allowance?: boolean;
  company_id?: string;
  /** `featured` ขึ้นก่อนเสมอ แล้วตามค่านี้: `newest` = `published_at` ใหม่ก่อน (ค่าเริ่มต้น), `deadline` = `application_deadline` ใกล้ก่อน */
  sort?: 'newest' | 'deadline';
}

/** ผลจาก GET /search/jobs: Job Object + `major_mismatch` เมื่อส่ง `major` */
export interface SearchJobItem extends JobObject {
  major_mismatch?: boolean;
}

// ---- §9 Internal (job) ----
export interface QuotaApplicationRequest {
  application_id: string;
}

export interface QuotaReleaseRequest {
  application_id: string;
  reason: string;
}

export interface QuotaReserveResponse {
  reserved: true;
}
