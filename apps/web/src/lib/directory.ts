import type { DirectoryCompanyListItem, Paginated } from '@internpath/contracts';
import { ApiError } from '@/lib/api';

type Request = <T>(path: string) => Promise<T>;

/**
 * `GET /directory/companies` ตามสัญญา §4.4: Public + Pagination มาตรฐาน `{data, meta}`
 *
 * ชั่วคราว: Identity บน main ยังเป็นฉบับก่อนการตัดสินใจ (ต้องล็อกอิน, ไม่รับ `page`/`page_size`, คืนอาร์เรย์เปล่า)
 * ถ้าเซิร์ฟเวอร์ปฏิเสธพารามิเตอร์แบ่งหน้า (400) ให้ลองใหม่โดยไม่ส่งแล้วแบ่งหน้าฝั่งหน้าจอ — ลบส่วนนี้ได้เมื่อ SA แก้ตามสัญญา
 */
export async function listCompanies(
  request: Request,
  filters: { q?: string; partner?: boolean },
  page: number,
  pageSize: number,
): Promise<Paginated<DirectoryCompanyListItem>> {
  const filter = new URLSearchParams();
  if (filters.q) filter.set('q', filters.q);
  if (filters.partner) filter.set('partner', 'true');
  const withPaging = new URLSearchParams(filter);
  withPaging.set('page', String(page));
  withPaging.set('page_size', String(pageSize));

  try {
    const result = await request<Paginated<DirectoryCompanyListItem> | DirectoryCompanyListItem[]>(`/directory/companies?${withPaging}`);
    return normalize(result, page, pageSize);
  } catch (cause) {
    if (!(cause instanceof ApiError) || cause.status !== 400 || !cause.issues.includes('whitelistValidation')) throw cause;
    const all = await request<DirectoryCompanyListItem[] | Paginated<DirectoryCompanyListItem>>(`/directory/companies?${filter}`);
    return normalize(all, page, pageSize);
  }
}

function normalize(result: Paginated<DirectoryCompanyListItem> | DirectoryCompanyListItem[], page: number, pageSize: number): Paginated<DirectoryCompanyListItem> {
  if (!Array.isArray(result)) return result;
  return { data: result.slice((page - 1) * pageSize, page * pageSize), meta: { page, page_size: pageSize, total: result.length } };
}
