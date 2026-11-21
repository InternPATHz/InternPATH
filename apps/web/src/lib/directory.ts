import type { DirectoryCompanyListItem, JobCategory, Paginated } from '@internpath/contracts';

type Request = <T>(path: string) => Promise<T>;

/** `GET /directory/companies` ตามสัญญา §4.4: Public + Pagination มาตรฐาน `{data, meta}` */
export async function listCompanies(
  request: Request,
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
  return request<Paginated<DirectoryCompanyListItem>>(`/directory/companies?${filter}`);
}
