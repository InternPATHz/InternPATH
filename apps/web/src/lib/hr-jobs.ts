import type {
  CreateJobRequest, HrJobDetail, HrJobObject, JobObject, JobStatus, Paginated,
  JobTag, UpdateJobRequest, UpdateJobResponse,
} from '@internpath/contracts';

/**
 * ชั้นเรียกข้อมูลของหน้าประกาศงานฝั่ง HR (api-contract §5.1)
 *
 * เรียก HR API จริงโดยค่าเริ่มต้น ตั้ง `NEXT_PUBLIC_HR_JOBS_MOCK=true` เพื่อใช้ข้อมูลจำลองตอนพัฒนา
 * ข้อมูลจำลองเก็บใน localStorage ของเบราว์เซอร์ (เฉพาะตอนพัฒนา) ถ้าใช้ไม่ได้จะเก็บในหน่วยความจำ
 */

export const HR_JOBS_MOCK = process.env.NEXT_PUBLIC_HR_JOBS_MOCK === 'true';

export type AuthRequest = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<T>;

export interface HrJobsApi {
  list(status?: JobStatus): Promise<Paginated<HrJobObject>>;
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
 * บริษัทปกติแก้แล้วคงสถานะ `PUBLISHED`; ข้อมูลจำลองของหน้านี้ถือว่าบริษัทไม่ติดธง
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

// ---------------------------------------------------------------- ของจริง

function realApi(request: AuthRequest): HrJobsApi {
  const base = (id: string) => `/hr/jobs/${encodeURIComponent(id)}`;
  return {
    list: (status) => request<Paginated<HrJobObject>>(`/hr/jobs${status ? `?status=${status}` : ''}`),
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

// ---------------------------------------------------------------- ข้อมูลจำลอง

interface MockRecord {
  job: HrJobDetail;
}

const STORAGE_KEY = 'internpath.mock.hr-jobs';

let memory: MockRecord[] | null = null;

function readAll(): MockRecord[] {
  if (memory) return memory;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    memory = raw ? (JSON.parse(raw) as MockRecord[]) : seed();
  } catch { memory = seed(); }
  return memory;
}

function writeAll(records: MockRecord[]) {
  memory = records;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(records)); } catch { /* ใช้หน่วยความจำต่อ */ }
}

export const MOCK_TAGS = [
  { id: 'mock-tag-nextjs', name: 'NextJs', slug: 'nextjs' }, { id: 'mock-tag-nestjs', name: 'NestJs', slug: 'nestjs' },
  { id: 'mock-tag-rust', name: 'Rust', slug: 'rust' }, { id: 'mock-tag-react', name: 'React', slug: 'react' },
  { id: 'mock-tag-python', name: 'Python', slug: 'python' }, { id: 'mock-tag-sql', name: 'SQL', slug: 'sql' },
];

const MOCK_COMPANY = { id: 'mock-company-1', name: 'บริษัท ตัวอย่าง จำกัด', badges: ['Verified by Platform'] };

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function seed(): MockRecord[] {
  const published: JobObject = {
    id: 'mock-hr-job-1', company: MOCK_COMPANY, category: 'TECH_IT', job_title: 'Frontend Developer Intern',
    description: 'พัฒนาหน้าเว็บด้วย React ร่วมกับทีมผลิตภัณฑ์', responsibilities: 'สร้างและปรับปรุงคอมโพเนนต์ของหน้าเว็บ',
    qualifications: 'นักศึกษาสาขาที่เกี่ยวข้อง ชั้นปี 3 ขึ้นไป', allowance: { type: 'AMOUNT', amount_thb: 300, text: '300 บาท/วัน' },
    location: 'กรุงเทพมหานคร', work_mode: 'HYBRID', hours_per_week: 40, period: { start: isoDay(60), end: isoDay(150) },
    target_majors: ['วิทยาการคอมพิวเตอร์'], tags: [MOCK_TAGS[3], MOCK_TAGS[0]], quota: 2, quota_available: 2, application_deadline: isoDay(20),
    status: 'PUBLISHED', featured: false, published_at: new Date().toISOString(),
  };
  const draft = {
    id: 'mock-hr-job-2', company: MOCK_COMPANY, category: null, job_title: 'Data Analyst Intern', description: null, responsibilities: null,
    qualifications: null, allowance: null, location: null, work_mode: null, hours_per_week: null, period: { start: null, end: null },
    target_majors: null, tags: [], quota: null, quota_available: null, application_deadline: null, status: 'DRAFT', featured: false,
  } as HrJobDetail;
  return [{ job: published as HrJobDetail }, { job: draft }];
}

function settle(): MockRecord[] {
  return readAll();
}

const delay = () => new Promise((resolve) => setTimeout(resolve, 200));
/** คืนสำเนาเสมอ เหมือน API จริง (ถ้าคืนอ็อบเจ็กต์เดิม React จะไม่เห็นว่าสถานะเปลี่ยน) */
const copy = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
const notFound = () => Object.assign(new Error('ไม่พบประกาศ'), { status: 404, code: 'NOT_FOUND', issues: [] as string[] });
const conflict = (issue: string) => Object.assign(new Error('สถานะของประกาศไม่อนุญาตให้ทำรายการนี้'), { status: 409, code: 'STATE_CONFLICT', issues: [issue] });

function pick(records: MockRecord[], id: string): MockRecord {
  const record = records.find((entry) => entry.job.id === id);
  if (!record) throw notFound();
  return record;
}

const EDITABLE: JobStatus[] = ['DRAFT', 'PUBLISHED', 'ADMIN_REJECTED', 'CLOSED'];
const CLOSED_FIELDS = ['quota', 'application_deadline', 'target_majors', 'period'];

function mockApi(): HrJobsApi {
  return {
    async list(status) {
      await delay();
      const data = settle().map((record) => copy(record.job)).filter((job) => !status || job.status === status);
      return { data, meta: { page: 1, page_size: 20, total: data.length } };
    },
    async get(id) { await delay(); return copy(pick(settle(), id).job); },
    async create(body) {
      await delay();
      const records = readAll();
      const { tag_ids: createTagIds, ...createBody } = body as typeof body & { tag_ids?: string[] };
      const job = {
        id: `mock-hr-job-${Date.now()}`, company: MOCK_COMPANY, category: null, job_title: null, description: null, responsibilities: null,
        qualifications: null, allowance: null, location: null, work_mode: null, hours_per_week: null, period: { start: null, end: null },
        target_majors: null, tags: [], quota: null, quota_available: null, application_deadline: null, status: 'DRAFT', featured: false, ...createBody,
      } as HrJobDetail;
      (job as { tags: unknown }).tags = (createTagIds ?? []).map((tagId) => MOCK_TAGS.find((tag) => tag.id === tagId) ?? { id: tagId, name: tagId, slug: tagId });
      writeAll([{ job }, ...records]);
      return copy(job);
    },
    async update(id, body) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      const status = record.job.status;
      if (status !== 'DRAFT' && body.category !== undefined) {
        if (body.category !== record.job.category) {
          throw Object.assign(new Error('เปลี่ยนสายงานได้เฉพาะประกาศฉบับร่าง'), { status: 400, code: 'VALIDATION_FAILED', issues: ['CATEGORY_LOCKED'] });
        }
        const { category: _category, ...rest } = body;
        body = rest;
        if (Object.keys(body).length === 0) return { ...copy(record.job), requires_reverification: false };
      }
      if (!EDITABLE.includes(status)) throw conflict('NOT_EDITABLE');
      if (status === 'CLOSED' && Object.keys(body).some((key) => !CLOSED_FIELDS.includes(key))) throw conflict('CLOSED_FIELD_LOCKED');
      const reverify = false; // บริษัทจำลองไม่ติดธง UNDER_REVIEW จึงไม่ต้องตรวจซ้ำ
      const { tag_ids: tagIds, ...rest } = body as typeof body & { tag_ids?: string[] };
      Object.assign(record.job, rest);
      if (tagIds) (record.job as { tags: unknown }).tags = tagIds.map((tagId) => MOCK_TAGS.find((tag) => tag.id === tagId) ?? { id: tagId, name: tagId, slug: tagId });
      writeAll(records);
      return { ...copy(record.job as HrJobDetail), requires_reverification: reverify } as UpdateJobResponse;
    },
    async submit(id) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      if (!['DRAFT', 'ADMIN_REJECTED'].includes(record.job.status)) throw conflict('NOT_SUBMITTABLE');
      const missing = missingRequired(record.job as unknown as Record<string, unknown>);
      if (missing.length > 0) throw Object.assign(new Error('ข้อมูลบังคับยังไม่ครบ'), { status: 400, code: 'MISSING_REQUIRED_JOB_FIELDS', issues: missing });
      // บริษัทไม่ติดธง ⇒ เผยแพร่ทันที (ไม่มีขั้นตรวจอัตโนมัติ)
      const job = record.job as JobObject;
      job.status = 'PUBLISHED';
      job.published_at = new Date().toISOString();
      job.quota_available = job.quota;
      writeAll(records);
      return copy(record.job);
    },
    async close(id) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      if (record.job.status !== 'PUBLISHED') throw conflict('NOT_PUBLISHED');
      record.job.status = 'CLOSED' as never;
      writeAll(records);
      return copy(record.job);
    },
    async tags() { await delay(); return copy(MOCK_TAGS); },
    async reopen(id) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      const job = record.job as JobObject;
      if (job.status !== 'CLOSED') throw conflict('NOT_CLOSED');
      if (job.application_deadline < isoDay(0)) throw conflict('DEADLINE_PASSED');
      job.status = 'PUBLISHED';
      writeAll(records);
      return copy(job);
    },
  };
}

export function hrJobsApi(request: AuthRequest): HrJobsApi {
  return HR_JOBS_MOCK ? mockApi() : realApi(request);
}
