import type {
  AppealResponse, CreateJobRequest, HrJobDetail, HrJobObject, JobObject, JobStatus, Paginated,
  UpdateJobRequest, UpdateJobResponse, VerificationResultResponse,
} from '@internpath/contracts';

/**
 * ชั้นเรียกข้อมูลของหน้าประกาศงานฝั่ง HR (api-contract §5.1, §6.5)
 *
 * ตอนนี้ใช้ข้อมูลจำลอง (MOCK) เพราะ HR APIs ของ Job ยังไม่เปิด — ตั้ง `NEXT_PUBLIC_HR_JOBS_MOCK=false` เพื่อสลับไปเรียก API จริง
 * โดยไม่ต้องแก้หน้าจอ (สองฝั่งอยู่ในไฟล์นี้ไฟล์เดียว และชนิดข้อมูลมาจาก `@internpath/contracts`)
 * ข้อมูลจำลองเก็บใน localStorage ของเบราว์เซอร์ (เฉพาะตอนพัฒนา) ถ้าใช้ไม่ได้จะเก็บในหน่วยความจำ
 */

export const HR_JOBS_MOCK = process.env.NEXT_PUBLIC_HR_JOBS_MOCK !== 'false';

export type AuthRequest = <T>(path: string, init?: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; body?: unknown }) => Promise<T>;

export interface HrJobsApi {
  list(status?: JobStatus): Promise<Paginated<HrJobObject>>;
  get(id: string): Promise<HrJobDetail>;
  create(body: CreateJobRequest): Promise<HrJobObject>;
  update(id: string, body: UpdateJobRequest): Promise<UpdateJobResponse>;
  submit(id: string): Promise<HrJobObject>;
  close(id: string): Promise<HrJobObject>;
  reopen(id: string): Promise<HrJobObject>;
  verificationResult(id: string): Promise<VerificationResultResponse | null>;
  appeal(id: string, statement: string): Promise<AppealResponse>;
}

/** ฟิลด์ที่ Verification ใช้ตัดสิน — แก้หลัง `PUBLISHED` แล้วต้องตรวจซ้ำ (data-schema §4) */
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
    // Verification เป็นเจ้าของผลตรวจ — ไม่เคยถูกตรวจ ⇒ 404 (ถือว่าไม่มีผล)
    verificationResult: async (id) => {
      try { return await request<VerificationResultResponse>(`/verification/jobs/${encodeURIComponent(id)}/result`); }
      catch (cause) { if ((cause as { status?: number }).status === 404) return null; throw cause; }
    },
    appeal: (id, statement) => request<AppealResponse>(`/verification/jobs/${encodeURIComponent(id)}/appeal`, { method: 'POST', body: { statement } }),
  };
}

// ---------------------------------------------------------------- ข้อมูลจำลอง

interface MockRecord {
  job: HrJobDetail;
  verifyingSince?: number;
  appealed?: boolean;
  appealAt?: number;
  result?: VerificationResultResponse;
}

const STORAGE_KEY = 'internpath.mock.hr-jobs';
const VERIFY_DELAY_MS = 4000; // จำลองเวลาตรวจ (จริง: Fail-safe 5 นาที)
const SUSPICIOUS = ['ค่าสมัคร', 'โอนเงิน', 'มัดจำ']; // จำลอง Blacklist: มีคำเหล่านี้ ⇒ ถูกตีกลับอัตโนมัติ

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

const MOCK_COMPANY = { id: 'mock-company-1', name: 'บริษัท ตัวอย่าง จำกัด', badges: ['Verified by Platform'] };

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);

function seed(): MockRecord[] {
  const published: JobObject = {
    id: 'mock-hr-job-1', company: MOCK_COMPANY, category: 'TECH_IT', job_title: 'Frontend Developer Intern',
    description: 'พัฒนาหน้าเว็บด้วย React ร่วมกับทีมผลิตภัณฑ์', responsibilities: 'สร้างและปรับปรุงคอมโพเนนต์ของหน้าเว็บ',
    qualifications: 'นักศึกษาสาขาที่เกี่ยวข้อง ชั้นปี 3 ขึ้นไป', allowance: { type: 'AMOUNT', amount_thb: 300, text: '300 บาท/วัน' },
    location: 'กรุงเทพมหานคร', work_mode: 'HYBRID', hours_per_week: 40, period: { start: isoDay(60), end: isoDay(150) },
    target_majors: ['วิทยาการคอมพิวเตอร์'], quota: 2, quota_available: 2, application_deadline: isoDay(20),
    status: 'PUBLISHED', featured: false, published_at: new Date().toISOString(),
  };
  const draft = {
    id: 'mock-hr-job-2', company: MOCK_COMPANY, category: null, job_title: 'Data Analyst Intern', description: null, responsibilities: null,
    qualifications: null, allowance: null, location: null, work_mode: null, hours_per_week: null, period: { start: null, end: null },
    target_majors: null, quota: null, quota_available: null, application_deadline: null, status: 'DRAFT', featured: false,
  } as HrJobDetail;
  return [{ job: published as HrJobDetail }, { job: draft }];
}

/** จำลองการตรวจ: ครบเวลา ⇒ ผ่าน หรือ (มีคำต้องสงสัย) ถูกตีกลับ และจำลอง Admin ตัดสินคำอุทธรณ์ */
function advance(record: MockRecord, now: number): boolean {
  const job = record.job as JobObject & { contact_notes?: string };
  if (job.status === 'VERIFYING' && record.verifyingSince && now - record.verifyingSince >= VERIFY_DELAY_MS) {
    const text = `${job.job_title} ${job.description} ${job.responsibilities} ${job.qualifications} ${job.location} ${job.contact_notes ?? ''}`;
    const hit = SUSPICIOUS.find((word) => text.includes(word));
    if (hit) {
      job.status = 'AUTO_REJECTED';
      record.result = {
        risk_level: 'HIGH', risk_score: 100, is_appeal: false, can_appeal: !record.appealed,
        reasons: [{ code: 'BLACKLIST_HARD', detail: 'พบคำที่ประกาศงานฝึกงานไม่อนุญาต', matched_text: hit }],
        matched_keywords: [{ term: hit, field: 'description', negated: false }],
      };
    } else {
      job.status = 'PUBLISHED';
      job.published_at = new Date().toISOString();
      job.quota_available = job.quota;
      record.result = { risk_level: 'LOW', risk_score: 0, is_appeal: false, can_appeal: false, reasons: [], matched_keywords: [] };
    }
    record.verifyingSince = undefined;
    return true;
  }
  if (job.status === 'PENDING_REVIEW' && record.appealAt && now - record.appealAt >= VERIFY_DELAY_MS) {
    job.status = 'ADMIN_REJECTED';
    record.result = {
      ...(record.result as VerificationResultResponse), is_appeal: true, can_appeal: false,
      admin_reason: 'ตรวจแล้วเนื้อหายังไม่เหมาะสม กรุณาแก้ไขแล้วส่งตรวจใหม่',
    };
    return true;
  }
  return false;
}

function settle(): MockRecord[] {
  const records = readAll();
  const now = Date.now();
  if (records.map((record) => advance(record, now)).some(Boolean)) writeAll(records);
  return records;
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

const EDITABLE: JobStatus[] = ['DRAFT', 'PUBLISHED', 'AUTO_REJECTED', 'ADMIN_REJECTED', 'CLOSED'];
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
      const job = {
        id: `mock-hr-job-${Date.now()}`, company: MOCK_COMPANY, category: null, job_title: null, description: null, responsibilities: null,
        qualifications: null, allowance: null, location: null, work_mode: null, hours_per_week: null, period: { start: null, end: null },
        target_majors: null, quota: null, quota_available: null, application_deadline: null, status: 'DRAFT', featured: false, ...body,
      } as HrJobDetail;
      writeAll([{ job }, ...records]);
      return copy(job);
    },
    async update(id, body) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      const status = record.job.status;
      if (!EDITABLE.includes(status)) throw conflict('NOT_EDITABLE');
      if (status === 'CLOSED' && Object.keys(body).some((key) => !CLOSED_FIELDS.includes(key))) throw conflict('CLOSED_FIELD_LOCKED');
      const reverify = status === 'PUBLISHED' && Object.keys(body).some((key) => (REVERIFY_FIELDS as readonly string[]).includes(key));
      Object.assign(record.job, body);
      if (reverify) { record.job.status = 'VERIFYING' as never; record.verifyingSince = Date.now(); }
      writeAll(records);
      return { ...copy(record.job as HrJobDetail), requires_reverification: reverify } as UpdateJobResponse;
    },
    async submit(id) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      if (!['DRAFT', 'AUTO_REJECTED', 'ADMIN_REJECTED'].includes(record.job.status)) throw conflict('NOT_SUBMITTABLE');
      const missing = missingRequired(record.job as unknown as Record<string, unknown>);
      if (missing.length > 0) throw Object.assign(new Error('ข้อมูลบังคับยังไม่ครบ'), { status: 400, code: 'MISSING_REQUIRED_JOB_FIELDS', issues: missing });
      record.job.status = 'VERIFYING' as never;
      record.verifyingSince = Date.now();
      record.result = undefined;
      record.appealed = record.appealed ?? false;
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
    async verificationResult(id) { await delay(); const result = pick(settle(), id).result; return result ? copy(result) : null; },
    async appeal(id, statement) {
      await delay();
      const records = settle();
      const record = pick(records, id);
      if (record.appealed) throw Object.assign(new Error('อุทธรณ์ได้ 1 ครั้งต่อประกาศ'), { status: 409, code: 'APPEAL_ALREADY_USED', issues: [] as string[] });
      if (record.job.status !== 'AUTO_REJECTED' || statement.trim().length < 20) throw conflict('NOT_APPEALABLE');
      record.appealed = true;
      record.appealAt = Date.now();
      record.job.status = 'PENDING_REVIEW' as never;
      if (record.result) record.result = { ...record.result, can_appeal: false, is_appeal: true };
      writeAll(records);
      return { id: `mock-appeal-${Date.now()}`, status: 'OPEN' };
    },
  };
}

export function hrJobsApi(request: AuthRequest): HrJobsApi {
  return HR_JOBS_MOCK ? mockApi() : realApi(request);
}
