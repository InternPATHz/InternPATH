import type { DirectoryCompanyListItem, JobCategory, Paginated } from '@internpath/contracts';
import { apiRequest } from '@/lib/api';

/**
 * `GET /directory/companies` ตามสัญญา §4.4: Public + Pagination มาตรฐาน `{data, meta}`
 * เรียกโดยไม่แนบ token — ห้ามใช้ `useAuth().request` (refresh session ก่อนเสมอ ผู้เยี่ยมชมจะได้ 401)
 */
export async function listCompanies(
  filters: { q?: string; category?: JobCategory; partner?: boolean },
  page: number,
  pageSize: number,
): Promise<Paginated<DirectoryCompanyListItem>> {
  const filter = new URLSearchParams();
  if (filters.q) filter.set('q', filters.q);
  if (filters.category) filter.set('category', filters.category);
  if (filters.partner) filter.set('partner', 'true');
  filter.set('page', String(page));
  filter.set('page_size', String(pageSize));
  return apiRequest<Paginated<DirectoryCompanyListItem>>(`/directory/companies?${filter}`);
}
