import type { DirectoryCompanyListItem, JobObject, JobTag, PageMeta, Paginated, SearchJobItem, SearchJobsQuery } from '@internpath/contracts';
import { ApiError, apiRequest } from '@/lib/api';

/**
 * ชั้นเรียกข้อมูลของหน้าค้นหางาน หน้ารายละเอียดงาน และหน้าแรก — ทุก endpoint เป็น Public (ไม่ส่ง Token)
 *   1) `GET /search/jobs?...&page=&page_size=` (Job) → `Paginated<SearchJobItem>` (api-contract §5.2)
 *   2) `GET /jobs/{id}` (Job) → `JobObject` เฉพาะ `PUBLISHED`/`CLOSED` อื่น ๆ ⇒ 404
 *   3) `GET /directory/companies?ids=<id>,<id>` (Identity, สูงสุด 50 ตัว) → คะแนนดาวของบริษัททั้งหน้าในครั้งเดียว
 *   4) `GET /tags` (Job) → Tag ทักษะที่เปิดใช้งาน
 * `major_mismatch` คำนวณที่ Job จากพารามิเตอร์ `major` (ไม่พึ่งตัวตนผู้เรียก)
 */

export type CompanyRating = Pick<DirectoryCompanyListItem, 'rating_avg' | 'review_count'>;

export type JobSearchResult = {
  jobs: SearchJobItem[];
  /** คีย์ = `company.id` — บริษัทที่ไม่อยู่ใน Directory (ไม่ใช่ VERIFIED) หรือโหลดคะแนนไม่สำเร็จจะไม่มีรายการ */
  ratings: Record<string, CompanyRating>;
  meta: PageMeta;
};

export const PAGE_SIZE = 6;
export const MAX_SEARCH_TAGS = 10;
const DIRECTORY_IDS_MAX = 50;

/** คะแนนดาวเป็นข้อมูลเสริม — Directory ล่มต้องไม่ทำให้ผลค้นหาหายทั้งหน้า (การ์ดจะแสดงว่ายังไม่มีคะแนน) */
async function ratingsOf(companyIds: string[]): Promise<Record<string, CompanyRating>> {
  const ids = [...new Set(companyIds)].slice(0, DIRECTORY_IDS_MAX);
  if (ids.length === 0) return {};
  const params = new URLSearchParams({ ids: ids.join(','), page_size: String(ids.length) });
  try {
    const result = await apiRequest<Paginated<DirectoryCompanyListItem>>(`/directory/companies?${params}`);
    return Object.fromEntries(result.data.map((company) => [company.id, { rating_avg: company.rating_avg, review_count: company.review_count }]));
  } catch {
    return {};
  }
}

export async function searchJobs(query: SearchJobsQuery, page: number, pageSize = PAGE_SIZE): Promise<JobSearchResult> {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query)) {
    if (value !== undefined && value !== '' && value !== false) params.set(name, String(value));
  }
  params.set('page', String(page));
  params.set('page_size', String(pageSize));
  const result = await apiRequest<Paginated<SearchJobItem>>(`/search/jobs?${params}`);
  const ratings = await ratingsOf(result.data.map((job) => job.company.id));
  return { jobs: result.data, ratings, meta: result.meta };
}

export type JobDetailResult = { job: JobObject; rating?: CompanyRating };

/** `null` = ไม่พบ/ไม่เปิดเผยต่อสาธารณะ (404) หรือ id ผิดรูปแบบ (400) — error อื่นโยนต่อให้หน้าจอแสดงว่าระบบไม่พร้อม */
export async function getJob(id: string): Promise<JobDetailResult | null> {
  let job: JobObject;
  try {
    job = await apiRequest<JobObject>(`/jobs/${encodeURIComponent(id)}`);
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 404 || cause.status === 400)) return null;
    throw cause;
  }
  const ratings = await ratingsOf([job.company.id]);
  return { job, rating: ratings[job.company.id] };
}

/** Tag ทักษะที่เปิดใช้งานทั้งหมด (เรียงตามชื่อ) สำหรับตัวกรองหน้าค้นหา */
export async function listTags(): Promise<JobTag[]> {
  const tags: JobTag[] = [];
  for (let page = 1; ; page++) {
    const result = await apiRequest<Paginated<JobTag>>(`/tags?page=${page}&page_size=100`);
    tags.push(...result.data);
    if (!result.data.length || page * result.meta.page_size >= result.meta.total) return tags;
  }
}
