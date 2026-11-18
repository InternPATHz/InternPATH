/**
 * `Promise.all` แบบจำกัดจำนวนที่ทำพร้อมกัน — คงลำดับผลลัพธ์ตาม `items`
 * ใช้กับการเรียก Service อื่นทีละรายการ (เช่น ตรวจ Consent ต่อผู้สมัคร) ไม่ให้ยิงทีเดียวทั้งหน้า
 * `fn` throw ⇒ reject ทั้งชุดเหมือน `Promise.all` (ผู้เรียกจัดการ error ต่อรายการเองถ้าต้องการ)
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError('limit ต้องเป็นจำนวนเต็ม ≥ 1');
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
