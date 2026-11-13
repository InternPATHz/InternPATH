// ต้องตรงกับ docs/api-contract.md §5 (Job) และ §9 (Internal) — เฉพาะที่เอกสารระบุไว้
import type { JobCategory, JobStatus, WorkMode } from '../enums';

/** Job Object (ย่อ) ตาม §5.1 */
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
  quota: number;
  quota_available: number;
  application_deadline: string;
  status: JobStatus;
  featured: boolean;
  published_at?: string;
}

export interface HrJobsQuery {
  status?: JobStatus;
}

/** GET /hr/jobs/{id} = Job Object + เหตุผลการตีกลับ (`reasons[]` จาก `JobVerified`) */
export interface HrJobDetail extends JobObject {
  reasons?: Array<{ code: string; detail: string; matched_text?: string }>;
}

/** PATCH /hr/jobs/{id} — Response ส่ง `requires_reverification` */
export interface UpdateJobResponse {
  requires_reverification: boolean;
}

export type HrJobAction = 'submit' | 'close' | 'reopen';

export interface SetFeaturedRequest {
  enabled: boolean;
}

export interface SearchJobsQuery {
  q?: string;
  category?: JobCategory;
  work_mode?: WorkMode;
  major?: string;
  allowance?: boolean;
  company_id?: string;
  sort?: string;
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
