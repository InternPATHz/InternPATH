import type { Paginated } from '@internpath/contracts';

/** รายการจาก API อาจเป็น `{data, meta}` (สัญญา §1) หรืออาร์เรย์เปล่า (บาง endpoint ของ Identity ที่ยังเป็นฉบับเดิม) */
export function asList<T>(value: Paginated<T> | T[] | null | undefined): T[] {
  if (!value) return [];
  return Array.isArray(value) ? value : value.data;
}
