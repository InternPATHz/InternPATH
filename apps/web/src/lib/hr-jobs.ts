import type {
  CreateJobRequest, HrJobDetail, HrJobObject, JobStatus, Paginated,
  JobTag, UpdateJobRequest, UpdateJobResponse,
} from '@internpath/contracts';

/** ชั้นเรียกข้อมูลของหน้าประกาศงานฝั่ง HR (api-contract §5.1) — Job Service ผ่าน Gateway */

export const HR_JOBS_PAGE_SIZE = 20;

export type AuthRequest = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<T>;

export interface HrJobsApi {
  list(status?: JobStatus, page?: number, pageSize?: number): Promise<Paginated<HrJobObject>>;
  get(id: string): Promise<HrJobDetail>;
  create(body: CreateJobRequest): Promise<HrJobObject>;
  update(id: string, body: UpdateJobRequest): Promise<UpdateJobResponse>;
  submit(id: string): Promise<HrJobObject>;
  close(id: string): Promise<HrJobObject>;
  reopen(id: string): Promise<HrJobObject>;
  /** Tag ทักษะที่เลือกได้ (`GET /tags` — Public) */
  tags(): Promise<JobTag[]>;
}

/**
 * ฟิลด์ข้อความอิสระ — แก้หลัง `PUBLISHED` แล้วต้องตรวจซ้ำ **เฉพาะบริษัทที่ติดธง UNDER_REVIEW** (data-schema §4; ปรับ 2026-11-21)
 * บริษัทปกติแก้แล้วคงสถานะ `PUBLISHED`
 */
export const REVERIFY_FIELDS = [
  'job_title', 'description', 'responsibilities', 'qualifications', 'allowance', 'location', 'contact_notes', 'work_mode', 'hours_per_week',
] as const;

/** ฟิลด์ที่ต้องครบก่อน `submit` (data-schema §4) — ใช้ตรวจฝั่งหน้าจอก่อนส่ง ค่าจริงตรวจที่ Job */
export function missingRequired(job: Partial<Record<string, unknown>>): string[] {
  const missing: string[] = [];
  const text = (key: string) => typeof job[key] === 'string' && (job[key] as string).trim() !== '';
  for (const key of ['category', 'job_title', 'description', 'responsibilities', 'qualifications', 'location', 'work_mode', 'application_deadline']) {
    if (!text(key)) missing.push(key);
  }
  if (!(Number(job.hours_per_week) > 0)) missing.push('hours_per_week');
  if (!(Number(job.quota) >= 1)) missing.push('quota');
  const allowance = job.allowance as { type?: string; amount_thb?: number } | null | undefined;
  if (!allowance || (allowance.type !== 'AMOUNT' && allowance.type !== 'NONE') || (allowance.type === 'AMOUNT' && !(Number(allowance.amount_thb) > 0))) {
    missing.push('allowance');
  }
  const period = job.period as { start?: string | null; end?: string | null } | undefined;
  if (!period?.start || !period?.end) missing.push('period');
  const majors = job.target_majors as string[] | null | undefined;
  if (!majors || majors.length === 0) missing.push('target_majors');
  const tagIds = job.tag_ids as string[] | undefined;
  const tags = job.tags as unknown[] | undefined;
  const tagCount = tagIds ? tagIds.length : (tags?.length ?? 0);
  if (tagCount < 1 || tagCount > 10) missing.push('tag_ids');
  return missing;
}

export function hrJobsApi(request: AuthRequest): HrJobsApi {
  const base = (id: string) => `/hr/jobs/${encodeURIComponent(id)}`;
  return {
    list: (status, page = 1, pageSize = HR_JOBS_PAGE_SIZE) => {
      const query = new URLSearchParams({ page: String(page), page_size: String(pageSize) });
      if (status) query.set('status', status);
      return request<Paginated<HrJobObject>>(`/hr/jobs?${query}`);
    },
    get: (id) => request<HrJobDetail>(base(id)),
    create: (body) => request<HrJobObject>('/hr/jobs', { method: 'POST', body }),
    update: (id, body) => request<UpdateJobResponse>(base(id), { method: 'PATCH', body }),
    submit: (id) => request<HrJobObject>(`${base(id)}/actions/submit`, { method: 'POST' }),
    close: (id) => request<HrJobObject>(`${base(id)}/actions/close`, { method: 'POST' }),
    reopen: (id) => request<HrJobObject>(`${base(id)}/actions/reopen`, { method: 'POST' }),
    tags: async () => {
      const tags: JobTag[] = [];
      let page = 1;
      let total: number;
      do {
        const response = await request<Paginated<JobTag>>(`/tags?page=${page}&page_size=100`);
        tags.push(...response.data);
        total = response.meta.total;
        page += 1;
        if (response.data.length === 0) break;
      } while (tags.length < total);
      return tags;
    },
  };
}
