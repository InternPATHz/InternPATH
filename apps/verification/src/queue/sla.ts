export interface SlaConfig {
  normalHours: number;
  fastHours: number;
}

/** token สำหรับ inject ค่า SLA (QUEUE_SLA_HOURS_NORMAL / QUEUE_SLA_HOURS_FAST) */
export const SLA_CONFIG = 'VERIFICATION_SLA_CONFIG';

const DEFAULT_NORMAL_HOURS = 48;
const DEFAULT_FAST_HOURS = 12;

export function slaFromConfig(get: (key: string) => unknown): SlaConfig {
  const num = (key: string, fallback: number): number => {
    const n = Number(get(key));
    return Number.isFinite(n) && n > 0 ? n : fallback;
  };
  return {
    normalHours: num('QUEUE_SLA_HOURS_NORMAL', DEFAULT_NORMAL_HOURS),
    fastHours: num('QUEUE_SLA_HOURS_FAST', DEFAULT_FAST_HOURS),
  };
}

/** due_at = เวลาสร้างรายการ + SLA (ชั่วโมงจริง) — Fast-Track 12 ชม., ปกติ 48 ชม. (README 5.3) */
export function computeDueAt(createdAt: Date, priority: 'NORMAL' | 'FAST_TRACK', cfg: SlaConfig): Date {
  const hours = priority === 'FAST_TRACK' ? cfg.fastHours : cfg.normalHours;
  return new Date(createdAt.getTime() + hours * 3600_000);
}

/** OVERDUE คำนวณตอนอ่าน: ยังไม่ RESOLVED และเลยกำหนดแล้ว */
export function isOverdue(item: { status: string; dueAt: Date }, now: Date): boolean {
  return item.status !== 'RESOLVED' && now.getTime() > item.dueAt.getTime();
}
