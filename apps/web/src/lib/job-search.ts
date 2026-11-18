import type { DirectoryCompanyListItem, PageMeta, SearchJobItem, SearchJobsQuery } from '@internpath/contracts';
import { MOCK_COMPANIES, MOCK_SEARCH_JOBS } from '@/lib/mock-jobs';

/**
 * ชั้นเรียกข้อมูลของหน้าค้นหางาน — ตอนนี้ใช้ข้อมูลจำลอง (MOCK) เมื่อ API พร้อมให้แทนที่ภายในไฟล์นี้ไฟล์เดียว:
 *   1) `GET /search/jobs?...&page=&page_size=` (Job, สาธารณะ) → `Paginated<SearchJobItem>`
 *   2) `GET /directory/companies?ids=<id>,<id>` (Identity, สาธารณะ, สูงสุด 50 ตัว) → คะแนนดาวของบริษัททั้งหน้าในครั้งเดียว
 * พฤติกรรมของ mock ตรงกับ api-contract §5.2: เฉพาะ `PUBLISHED`, `featured` ขึ้นก่อนเสมอ แล้วตาม `sort` (ค่าเริ่มต้น `newest`),
 * `major_mismatch` คำนวณจากพารามิเตอร์ `major` เท่านั้น (ไม่พึ่งตัวตนผู้เรียก)
 */

export type CompanyRating = Pick<DirectoryCompanyListItem, 'rating_avg' | 'review_count'>;

export type JobSearchResult = {
  jobs: SearchJobItem[];
  /** คีย์ = `company.id` — ได้จาก Directory แยกต่างหาก บริษัทที่ไม่อยู่ในผลลัพธ์ (ไม่ใช่ VERIFIED) จะไม่มีรายการ */
  ratings: Record<string, CompanyRating>;
  meta: PageMeta;
};

export const PAGE_SIZE = 6;

const MOCK_LATENCY_MS = 250;

const normalize = (text: string) => text.toLocaleLowerCase('th-TH').trim();

/**
 * กฎเทียบสาขาเดียวกับ `POST /applications` ของ Lifecycle (api-contract §7.2, §5.2 — PM ตัดสิน 2026-11-18):
 * ตัดช่องว่างหัวท้าย ยุบช่องว่างซ้อน ไม่สนตัวพิมพ์ แล้วเทียบ "ตรงทั้งค่า" (ไม่ใช่ substring)
 */
export const normalizeMajor = (text: string) => text.replace(/\s+/g, ' ').trim().toLocaleLowerCase('th-TH');

/** `major_mismatch`: ประกาศที่ไม่ระบุสาขา ⇒ false (เตือนเท่านั้น ไม่บล็อก) */
export const isMajorMismatch = (targetMajors: string[], major: string) =>
  targetMajors.length > 0 && !targetMajors.some((target) => normalizeMajor(target) === normalizeMajor(major));

function byFeaturedThen(sort: NonNullable<SearchJobsQuery['sort']>) {
  return (a: SearchJobItem, b: SearchJobItem) => {
    if (a.featured !== b.featured) return a.featured ? -1 : 1;
    if (sort === 'deadline') return a.application_deadline.localeCompare(b.application_deadline);
    return (b.published_at ?? '').localeCompare(a.published_at ?? '');
  };
}

export async function searchJobs(query: SearchJobsQuery, page: number, pageSize = PAGE_SIZE): Promise<JobSearchResult> {
  // MOCK: เลียนแบบเวลาตอบของเครือข่าย เพื่อให้เห็นสถานะกำลังโหลดตอนพัฒนา
  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));

  const q = query.q ? normalize(query.q) : '';
  // `major` ที่มีแต่ช่องว่างถือว่าไม่ส่ง (เหมือนฝั่ง API)
  const major = query.major && normalizeMajor(query.major) ? query.major : '';
  const matched = MOCK_SEARCH_JOBS
    .filter((job) => job.status === 'PUBLISHED')
    .filter((job) => !query.category || job.category === query.category)
    .filter((job) => !query.work_mode || job.work_mode === query.work_mode)
    .filter((job) => !query.allowance || job.allowance.type === 'AMOUNT')
    .filter((job) => !query.company_id || job.company.id === query.company_id)
    .filter((job) => !q || normalize(`${job.job_title} ${job.company.name}`).includes(q))
    .sort(byFeaturedThen(query.sort ?? 'newest'));

  const jobs = matched
    .slice((page - 1) * pageSize, page * pageSize)
    .map((job): SearchJobItem => (major
      ? { ...job, major_mismatch: isMajorMismatch(job.target_majors, major) }
      : job));

  const ratings: Record<string, CompanyRating> = {};
  for (const job of jobs) {
    const company = MOCK_COMPANIES.find((entry) => entry.id === job.company.id);
    if (company) ratings[company.id] = company.rating;
  }
  return { jobs, ratings, meta: { page, page_size: pageSize, total: matched.length } };
}

export type JobDetailResult = { job: SearchJobItem; rating?: CompanyRating };

/**
 * `GET /jobs/{id}` (สาธารณะ): เฉพาะ `PUBLISHED`/`CLOSED` สถานะอื่นหรือไม่พบ ⇒ `404` (ที่นี่คืน `null`)
 * MOCK: ใช้ข้อมูลตัวอย่างชุดเดียวกับหน้าค้นหา; คะแนนดาวมาจาก `GET /directory/companies/{id}` ในของจริง
 */
export async function getJob(id: string): Promise<JobDetailResult | null> {
  await new Promise((resolve) => setTimeout(resolve, MOCK_LATENCY_MS));
  const job = MOCK_SEARCH_JOBS.find((entry) => entry.id === id);
  if (!job || (job.status !== 'PUBLISHED' && job.status !== 'CLOSED')) return null;
  return { job, rating: MOCK_COMPANIES.find((entry) => entry.id === job.company.id)?.rating };
}
