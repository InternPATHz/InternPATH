/** วันที่ของ State Machine นับตามปฏิทิน Asia/Bangkok (README §5.3) — คอลัมน์ `@db.Date` เก็บเป็นเที่ยงคืน UTC */

const DAY_MS = 86_400_000;
const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000; // Asia/Bangkok ไม่มี DST

/** วันที่ปัจจุบันตามปฏิทินกรุงเทพ คืนเป็น Date เที่ยงคืน UTC (เทียบกับคอลัมน์ date ได้ตรง) */
export function bangkokToday(now: Date): Date {
  const shifted = new Date(now.getTime() + BANGKOK_OFFSET_MS);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
}

/** แปลง Date/`YYYY-MM-DD` เป็นเที่ยงคืน UTC ของวันนั้น */
export function toDateOnly(value: Date | string): Date {
  if (typeof value === 'string') {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) throw new RangeError(`Invalid date: ${value}`);
    return new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  }
  return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
}

/** จำนวนวันจาก `from` ถึง `to` (to − from) ตามวันที่ ไม่สนเวลา */
export function daysBetween(from: Date | string, to: Date | string): number {
  return Math.round((toDateOnly(to).getTime() - toDateOnly(from).getTime()) / DAY_MS);
}

export function addDays(value: Date, days: number): Date {
  return new Date(value.getTime() + days * DAY_MS);
}
