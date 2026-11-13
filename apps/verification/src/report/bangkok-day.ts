const BANGKOK_OFFSET_MS = 7 * 3_600_000; // UTC+7 ไม่มี DST
const DAY_MS = 86_400_000;

/** เวลา 00:00 ของวัน (ปฏิทิน Asia/Bangkok) ที่ `now` อยู่ในนั้น — ใช้นับโควตา "ต่อวัน" */
export function startOfBangkokDay(now: Date): Date {
  const local = now.getTime() + BANGKOK_OFFSET_MS;
  return new Date(Math.floor(local / DAY_MS) * DAY_MS - BANGKOK_OFFSET_MS);
}

/** เวลา 00:00 ของวันถัดไป (ไทย) — ใช้คำนวณ Retry-After */
export function startOfNextBangkokDay(now: Date): Date {
  return new Date(startOfBangkokDay(now).getTime() + DAY_MS);
}
