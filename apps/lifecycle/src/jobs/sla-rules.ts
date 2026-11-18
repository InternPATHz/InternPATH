import type { ApplicationStatus, ReminderType } from '@internpath/contracts';
import type { LifecycleConfigKey } from '../config/lifecycle.constants';
import { addDays, bangkokToday, daysBetween } from '../state-machine/dates';
import { actualDays, noEvaluationBaseDate } from '../state-machine/guards';

/**
 * กติกา SLA ของ README §5.3 เป็นฟังก์ชันล้วน (ไม่แตะ DB) — Scheduler (`SlaSchedulerService`) เรียกทุกรอบ
 *
 * - นับเป็น **วันตามปฏิทิน Asia/Bangkok** จาก "วันฐาน" ของแต่ละสถานะ
 * - เวลาที่ถูก Freeze สะสม (`sla_paused_seconds`) หักออกจาก "ตอนนี้" ก่อนนับ และใบที่กำลัง `frozen` ไม่ถูกนับเลย
 *   (ประกาศถูกซ่อน / บริษัทถูกระงับ — README §5.1.2, data-schema §8.2.2)
 * - ถึงวันหมดอายุ ⇒ `EXPIRED` (การเปลี่ยนสถานะ ไม่ใช่ `ReminderDue`); ไม่งั้นส่งเตือน **ขั้นล่าสุดที่ถึงแล้ว** ขั้นเดียว
 *   (ขั้นก่อนหน้าที่เลยมาแล้ว เช่น Scheduler ล่มหลายวัน ไม่ส่งย้อนหลัง)
 * - `due_date` = วันฐาน + วันของขั้น — **ไม่ขยับตามเวลา Freeze** จึงเป็น key ของ `reminder_log` ที่คงที่ (เตือนครั้งเดียวจริง)
 * - ผู้รับ Admin ไม่อยู่ใน `audience`: Notification เติม Admin เองสำหรับ reminder_type ที่เป็นการยกระดับ
 *   (ผู้ใช้ตัดสิน 18 พ.ย. 2026 — แบบเดียวกับ `ProblemReportCreated`; Lifecycle เรียก `GET /internal/v1/admins` ไม่ได้)
 */

/** ผู้รับที่ Lifecycle ระบุ user_id ได้เอง (`COMPANY_HR` = สมาชิกทุกคนของบริษัทจาก Identity) */
export type SlaAudience = 'COMPANY_HR' | 'STUDENT' | 'ADVISOR';

/** ขั้นเตือน: ส่งเมื่อนับได้ ≥ `day` */
export interface SlaMilestone {
  day: number;
  type: ReminderType;
  audience: readonly SlaAudience[];
}

/** reminder_type ที่ Notification ต้องเติม Admin เป็นผู้รับ (README §5.3 "แจ้ง Admin") */
export const ADMIN_ESCALATION_TYPES: readonly ReminderType[] = Object.freeze([
  'ADVISOR_APPROVE_ESCALATE_ADMIN_D7',
  'START_CONFIRM_ESCALATE_D7',
  'EVALUATE_ESCALATE_D14',
  'ISSUE_CERT_ESCALATE_D14',
  'DISPUTE_ESCALATE_D7',
]);

/** `type` ของแถว `reminder_log` สำหรับการหมดอายุ (ไม่ใช่ `ReminderType` — ไม่ส่ง E14) */
export const EXPIRE_LOG_TYPE = 'EXPIRED';

/** ค่าที่ Scheduler โหลดจาก config กลาง (`config_overrides` > env > ค่าเริ่มต้น) ทุกรอบ */
export const SLA_CONFIG_KEYS = [
  'SLA_PENDING_DAYS',
  'SLA_PENDING_REMINDER_D3',
  'SLA_PENDING_REMINDER_D7',
  'SLA_ACCEPTED_DAYS',
  'SLA_ACCEPTED_REMINDER_D3',
  'SLA_ADVISOR_PENDING_DAYS',
  'SLA_ADVISOR_PENDING_REMINDER_D3',
  'SLA_START_CONFIRM_DAYS',
  'SLA_START_CONFIRM_REMINDER_D3',
  'SLA_START_CONFIRM_ESCALATE_D7',
  'SLA_EVALUATION_DAYS',
  'SLA_EVALUATION_REMINDER_D3',
  'SLA_CERT_ISSUE_DAYS',
  'SLA_CERT_ISSUE_REMINDER_D3',
  'SLA_DISPUTE_DAYS',
  'SLA_DISPUTE_REMINDER_D3',
  'CERT_MIN_ACTUAL_DAYS',
] as const satisfies readonly LifecycleConfigKey[];

export type SlaConfig = Record<(typeof SLA_CONFIG_KEYS)[number], number>;

/** สถานะที่ Scheduler ต้องตรวจ */
export const SLA_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'PENDING',
  'HR_ACCEPTED',
  'ADVISOR_PENDING',
  'ADVISOR_APPROVED',
  'IN_PROGRESS',
  'TERMINATED',
  'REEVALUATION_REQUESTED',
  'EVALUATED_PASS',
  'FAIL_DISPUTED',
]);

/** ฟิลด์ใบสมัครที่กติกาใช้ (ชื่อตาม Prisma model `Application`) */
export interface SlaApplication {
  status: ApplicationStatus;
  frozen: boolean;
  slaPausedSeconds: number;
  statusChangedAt: Date;
  startDate: Date | null;
  endDate: Date | null;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
}

export interface SlaFacts {
  /** `EVALUATED_PASS` — มีใบรับรองของใบสมัครนี้แล้ว (ไม่ต้องเตือนออกใบ) */
  hasCertificate?: boolean;
}

interface SlaPlan {
  base: Date;
  milestones: readonly SlaMilestone[];
  /** หมดอายุเมื่อนับได้ ≥ ค่านี้ */
  expireDay?: number;
}

export type SlaDecision =
  | { kind: 'NONE' }
  | { kind: 'EXPIRE'; dueDate: Date; elapsedDays: number }
  | { kind: 'REMIND'; milestone: SlaMilestone; dueDate: Date; elapsedDays: number; deadline?: Date };

const NONE: SlaDecision = { kind: 'NONE' };

/** วันฐานและขั้นของแต่ละสถานะตามตาราง README §5.3 */
export function slaPlan(app: SlaApplication, config: SlaConfig, facts: SlaFacts = {}): SlaPlan | null {
  const changedOn = bangkokToday(app.statusChangedAt);
  switch (app.status) {
    case 'PENDING':
      return {
        base: changedOn,
        milestones: [
          { day: config.SLA_PENDING_REMINDER_D3, type: 'HR_RESPOND_PENDING_D3', audience: ['COMPANY_HR'] },
          { day: config.SLA_PENDING_REMINDER_D7, type: 'HR_RESPOND_PENDING_D7', audience: ['COMPANY_HR'] },
        ],
        expireDay: config.SLA_PENDING_DAYS,
      };
    case 'HR_ACCEPTED':
      return {
        base: changedOn,
        milestones: [{ day: config.SLA_ACCEPTED_REMINDER_D3, type: 'STUDENT_CONFIRM_D3', audience: ['STUDENT'] }],
        expireDay: config.SLA_ACCEPTED_DAYS,
      };
    case 'ADVISOR_PENDING':
      // ไม่อนุมัติอัตโนมัติ — วัน 7 แค่แจ้ง Admin
      return {
        base: changedOn,
        milestones: [
          { day: config.SLA_ADVISOR_PENDING_REMINDER_D3, type: 'ADVISOR_APPROVE_D3', audience: ['ADVISOR'] },
          { day: config.SLA_ADVISOR_PENDING_DAYS, type: 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7', audience: [] },
        ],
      };
    case 'ADVISOR_APPROVED':
      // นับจาก start_date: เตือนในวันนั้นและ +3; "เกิน 7 วัน" แจ้งอาจารย์/Admin; "เกิน 14 วัน" EXPIRED (README §5.2.2)
      if (!app.startDate) return null;
      return {
        base: app.startDate,
        milestones: [
          { day: 0, type: 'HR_START_CONFIRM_ON_START', audience: ['COMPANY_HR'] },
          { day: config.SLA_START_CONFIRM_REMINDER_D3, type: 'HR_START_CONFIRM_D3', audience: ['COMPANY_HR'] },
          { day: config.SLA_START_CONFIRM_ESCALATE_D7 + 1, type: 'START_CONFIRM_ESCALATE_D7', audience: ['ADVISOR'] },
        ],
        expireDay: config.SLA_START_CONFIRM_DAYS + 1,
      };
    case 'IN_PROGRESS':
    case 'TERMINATED':
    case 'REEVALUATION_REQUESTED': {
      // รอประเมิน — วันฐานเดียวกับ Guard ของ `confirm-no-evaluation` (`noEvaluationBaseDate`)
      // TERMINATED ที่ฝึกจริงไม่ถึงเกณฑ์ไม่มีการประเมิน (อาจารย์ตัดสินผลเอง) ⇒ ไม่เตือน
      if (app.status === 'TERMINATED' && (actualDays(app) ?? -1) < config.CERT_MIN_ACTUAL_DAYS) return null;
      const base = noEvaluationBaseDate(app);
      if (!base) return null;
      return {
        base,
        milestones: [
          { day: config.SLA_EVALUATION_REMINDER_D3, type: 'HR_EVALUATE_D3', audience: ['COMPANY_HR'] },
          { day: config.SLA_EVALUATION_DAYS, type: 'EVALUATE_ESCALATE_D14', audience: ['ADVISOR'] },
        ],
      };
    }
    case 'EVALUATED_PASS':
      // เฉพาะที่ฝึกจริงครบเกณฑ์ (ออกใบได้) และยังไม่มีใบ
      if (facts.hasCertificate || (actualDays(app) ?? -1) < config.CERT_MIN_ACTUAL_DAYS) return null;
      return {
        base: changedOn,
        milestones: [
          { day: config.SLA_CERT_ISSUE_REMINDER_D3, type: 'HR_ISSUE_CERT_D3', audience: ['COMPANY_HR'] },
          { day: config.SLA_CERT_ISSUE_DAYS, type: 'ISSUE_CERT_ESCALATE_D14', audience: [] },
        ],
      };
    case 'FAIL_DISPUTED':
      return {
        base: changedOn,
        milestones: [
          { day: config.SLA_DISPUTE_REMINDER_D3, type: 'ADVISOR_DISPUTE_D3', audience: ['ADVISOR'] },
          { day: config.SLA_DISPUTE_DAYS, type: 'DISPUTE_ESCALATE_D7', audience: [] },
        ],
      };
    default:
      return null;
  }
}

/** จำนวนวันที่นับได้ (หักเวลา Freeze สะสม) — ใบที่กำลัง Freeze คืน `null` (หยุดนับ) */
export function elapsedSlaDays(app: SlaApplication, base: Date, now: Date): number | null {
  if (app.frozen) return null;
  const effectiveNow = new Date(now.getTime() - Math.max(0, app.slaPausedSeconds) * 1000);
  return daysBetween(base, bangkokToday(effectiveNow));
}

/** ตัดสินว่ารอบนี้ต้องทำอะไรกับใบสมัคร: หมดอายุ / เตือนขั้นล่าสุดที่ถึง / ไม่ทำ */
export function decideSla(app: SlaApplication, config: SlaConfig, now: Date, facts: SlaFacts = {}): SlaDecision {
  const plan = slaPlan(app, config, facts);
  if (!plan) return NONE;
  const elapsed = elapsedSlaDays(app, plan.base, now);
  if (elapsed === null) return NONE;

  if (plan.expireDay !== undefined && elapsed >= plan.expireDay) {
    return { kind: 'EXPIRE', dueDate: addDays(plan.base, plan.expireDay), elapsedDays: elapsed };
  }
  const reached = plan.milestones.filter((m) => elapsed >= m.day).sort((a, b) => b.day - a.day)[0];
  if (!reached) return NONE;
  return {
    kind: 'REMIND',
    milestone: reached,
    dueDate: addDays(plan.base, reached.day),
    elapsedDays: elapsed,
    ...(plan.expireDay !== undefined ? { deadline: addDays(plan.base, plan.expireDay) } : {}),
  };
}

/** วันที่ (เที่ยงคืน UTC) ⇒ เวลาเริ่มวันนั้นตามเขตเวลาไทยแบบ ISO-8601 UTC (ใช้ใน `context.deadline_at`) */
export function bangkokStartOfDay(date: Date): string {
  return new Date(date.getTime() - 7 * 60 * 60 * 1000).toISOString();
}
