import type { Paginated } from '@internpath/contracts';

/** รายการจาก API อาจเป็น `{data, meta}` (สัญญา §1) หรืออาร์เรย์เปล่า (บาง endpoint ของ Identity ที่ยังเป็นฉบับเดิม) */
export function asList<T>(value: Paginated<T> | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : value.data;
}

/** Some personal lists must be joined or grouped before paginating the view. */
export async function allPages<T>(load: (page: number) => Promise<Paginated<T> | T[]>): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page++) {
    const response = await load(page);
    if (Array.isArray(response)) return [...items, ...response];
    items.push(...response.data);
    if (!response.data.length || page * response.meta.page_size >= response.meta.total) return items;
  }
}
