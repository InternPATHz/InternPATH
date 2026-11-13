export interface LimitsConfig {
  /** จำนวนบัญชีที่รายงานแล้วระงับประกาศ (REPORT_THRESHOLD) */
  reportThreshold: number;
  /** รายงานได้กี่ครั้งต่อวันต่อผู้ใช้ (REPORT_DAILY_LIMIT) */
  reportDailyLimit: number;
  /** ถูกยกคำร้องติดกันกี่ครั้งแล้วรายงานถัดไปไม่นับ (REPORTER_DISMISS_STREAK) */
  reporterDismissStreak: number;
  /** ประกาศถูกปฏิเสธ/ระงับ/ลบกี่ครั้งแล้วติดธง (REJECTION_THRESHOLD) */
  rejectionThreshold: number;
  /** หน้าต่างเวลานับการปฏิเสธ เป็นวัน (REJECTION_WINDOW_DAYS) */
  rejectionWindowDays: number;
}

/** token สำหรับ inject ค่าเกณฑ์ของสไลซ์ 2 */
export const LIMITS_CONFIG = 'VERIFICATION_LIMITS_CONFIG';

export function limitsFromConfig(get: (key: string) => unknown): LimitsConfig {
  const int = (key: string, fallback: number): number => {
    const n = Number(get(key));
    return Number.isInteger(n) && n > 0 ? n : fallback;
  };
  return {
    reportThreshold: int('REPORT_THRESHOLD', 3),
    reportDailyLimit: int('REPORT_DAILY_LIMIT', 5),
    reporterDismissStreak: int('REPORTER_DISMISS_STREAK', 3),
    rejectionThreshold: int('REJECTION_THRESHOLD', 3),
    rejectionWindowDays: int('REJECTION_WINDOW_DAYS', 30),
  };
}
