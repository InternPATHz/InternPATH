import type { AppException } from '@internpath/common';
import type { AcademicResult, ApplicationStatus } from '@internpath/contracts';
import { bangkokToday, daysBetween } from './dates';
import {
  alreadyConfirmedElsewhere,
  disputeWindowClosed,
  evaluationNotOpen,
  invalidPeriod,
  reasonRequired,
  stateConflict,
  validationFailed,
} from './errors';
import type { GuardName } from './transition-table';

const DAY_MS = 86_400_000;

/** ข้อมูลใบสมัครที่ Guard ใช้ (ชื่อฟิลด์ตาม Prisma model `Application`) */
export interface GuardApplication {
  status: ApplicationStatus;
  frozen: boolean;
  startDate: Date | null;
  endDate: Date | null;
  actualStartDate: Date | null;
  actualEndDate: Date | null;
  reevaluationUsed: boolean;
  /** ฐานนับของ `REEVALUATION_REQUESTED → NO_EVALUATION` (วันที่อาจารย์สั่งประเมินใหม่) */
  statusChangedAt: Date;
}

export interface GuardConfig {
  /** `CERT_MIN_ACTUAL_DAYS` — ใช้ทั้งช่วงฝึก ≥ 30 วัน และฝึกจริงก่อนยุติ */
  minActualDays: number;
  /** `DISPUTE_WINDOW_DAYS` */
  disputeWindowDays: number;
  /** `SLA_EVALUATION_DAYS` — ครบกี่วันจากวันฐาน (`noEvaluationBaseDate`) จึงยืนยัน `NO_EVALUATION` ได้ */
  noEvaluationAfterDays: number;
}

/** ข้อมูลที่ผู้ใช้ส่งมากับคำสั่ง */
export interface GuardInput {
  reason?: string;
  startDate?: Date;
  endDate?: Date;
  academicResult?: AcademicResult;
}

export interface GuardContext {
  application: GuardApplication;
  now: Date;
  config: GuardConfig;
  input?: GuardInput;
  /** มีใบสมัครอื่นของนักศึกษาคนนี้ใน `CONFIRMED_STATUSES` */
  studentHasOtherConfirmed?: boolean;
  /** `evaluated_at` ของผลประเมินล่าสุด */
  lastEvaluatedAt?: Date | null;
  /** มีคำโต้แย้งที่สร้างหลังผลประเมินล่าสุดแล้ว (โต้แย้งได้ 1 ครั้งต่อผลประเมิน) */
  disputedSinceLastEvaluation?: boolean;
  /** คำโต้แย้งของผลประเมินล่าสุดได้รับการตัดสินแล้ว (โต้แย้งจบ) */
  disputeResolvedSinceLastEvaluation?: boolean;
}

/**
 * `probe` = ใช้ตอนคำนวณ `available_actions[]` (ยังไม่มีข้อมูลจากผู้ใช้) — ข้าม Guard ที่ต้องใช้ input
 * `execute` = ใช้ตอนเปลี่ยนสถานะจริง
 */
export type GuardMode = 'probe' | 'execute';

interface GuardDefinition {
  needsInput: boolean;
  check(ctx: GuardContext): AppException | null;
}

export function isDisputeWindowOpen(evaluatedAt: Date, now: Date, windowDays: number): boolean {
  return now.getTime() <= evaluatedAt.getTime() + windowDays * DAY_MS;
}

/** วันฝึกจริง = actual_end − actual_start (null เมื่อยังไม่มีข้อมูลครบ) */
export function actualDays(app: Pick<GuardApplication, 'actualStartDate' | 'actualEndDate'>): number | null {
  if (!app.actualStartDate || !app.actualEndDate) return null;
  return daysBetween(app.actualStartDate, app.actualEndDate);
}

/** ค่า `academic_result` ที่บันทึกได้ตามสถานะ (data-schema §8.1) */
export function allowedAcademicResults(status: ApplicationStatus): readonly AcademicResult[] {
  switch (status) {
    case 'EVALUATED_PASS':
    case 'TERMINATED':
    case 'NO_EVALUATION':
      return ['ACADEMIC_PASS', 'ACADEMIC_FAIL', 'REPEAT_REQUIRED'];
    case 'EVALUATED_FAIL':
      // ห้ามเปลี่ยน FAIL ของบริษัทเป็น PASS (README 5.2, UAT-21)
      return ['ACADEMIC_FAIL', 'REPEAT_REQUIRED'];
    default:
      return [];
  }
}

export const GUARDS: Readonly<Record<GuardName, GuardDefinition>> = Object.freeze({
  reasonRequired: {
    needsInput: true,
    check: (ctx) => (ctx.input?.reason?.trim() ? null : reasonRequired()),
  },
  periodMin30Days: {
    needsInput: true,
    check: (ctx) => {
      const { startDate, endDate } = ctx.input ?? {};
      if (!startDate) return validationFailed('start_date', 'REQUIRED');
      if (!endDate) return validationFailed('end_date', 'REQUIRED');
      return daysBetween(startDate, endDate) >= ctx.config.minActualDays ? null : invalidPeriod();
    },
  },
  notConfirmedElsewhere: {
    needsInput: false,
    check: (ctx) => (ctx.studentHasOtherConfirmed ? alreadyConfirmedElsewhere() : null),
  },
  notFrozen: {
    needsInput: false,
    check: (ctx) => (ctx.application.frozen ? stateConflict('JOB_FROZEN') : null),
  },
  endDateReached: {
    needsInput: false,
    check: (ctx) => {
      const { endDate } = ctx.application;
      if (!endDate) return evaluationNotOpen('END_DATE_NOT_SET');
      return daysBetween(endDate, bangkokToday(ctx.now)) >= 0 ? null : evaluationNotOpen('BEFORE_END_DATE');
    },
  },
  terminatedAfterMinDays: {
    needsInput: false,
    check: (ctx) => {
      const days = actualDays(ctx.application);
      return days !== null && days >= ctx.config.minActualDays ? null : evaluationNotOpen('ACTUAL_DAYS_BELOW_MIN');
    },
  },
  disputeWindowOpen: {
    needsInput: false,
    check: (ctx) => {
      if (!ctx.lastEvaluatedAt) return disputeWindowClosed();
      if (ctx.disputedSinceLastEvaluation) return stateConflict('ALREADY_DISPUTED');
      return isDisputeWindowOpen(ctx.lastEvaluatedAt, ctx.now, ctx.config.disputeWindowDays)
        ? null
        : disputeWindowClosed();
    },
  },
  disputeWindowClosed: {
    needsInput: false,
    check: (ctx) => {
      if (ctx.disputeResolvedSinceLastEvaluation) return null;
      if (!ctx.lastEvaluatedAt) return stateConflict('EVALUATION_MISSING');
      return isDisputeWindowOpen(ctx.lastEvaluatedAt, ctx.now, ctx.config.disputeWindowDays)
        ? stateConflict('DISPUTE_WINDOW_OPEN')
        : null;
    },
  },
  reevaluationNotUsed: {
    needsInput: false,
    check: (ctx) => (ctx.application.reevaluationUsed ? stateConflict('REEVALUATION_ALREADY_USED') : null),
  },
  academicResultAllowed: {
    needsInput: true,
    check: (ctx) => {
      const result = ctx.input?.academicResult;
      if (!result) return validationFailed('academic_result', 'REQUIRED');
      if (allowedAcademicResults(ctx.application.status).includes(result)) return null;
      return validationFailed(
        'academic_result',
        ctx.application.status === 'EVALUATED_FAIL' ? 'COMPANY_FAIL_CANNOT_BECOME_PASS' : 'NOT_ALLOWED',
      );
    },
  },
  evaluationOverdue: {
    needsInput: false,
    check: (ctx) => {
      const base = noEvaluationBaseDate(ctx.application);
      if (!base) return stateConflict('NO_EVALUATION_BASE_DATE_MISSING');
      return daysBetween(base, bangkokToday(ctx.now)) >= ctx.config.noEvaluationAfterDays
        ? null
        : stateConflict('EVALUATION_NOT_OVERDUE');
    },
  },
});

/**
 * วันฐานนับ 14 วันก่อน Admin ยืนยัน `NO_EVALUATION` (PM ตัดสินในรีวิว PR #36 — data-schema §8.1):
 * `IN_PROGRESS` = `end_date`, `TERMINATED` = `actual_end_date`, `REEVALUATION_REQUESTED` = วันของ `status_changed_at` (เวลาไทย)
 * ใช้ทั้ง Guard และ query `no-evaluation-candidates` (1.9) ให้นับตรงกัน
 */
export function noEvaluationBaseDate(
  app: Pick<GuardApplication, 'status' | 'endDate' | 'actualEndDate' | 'statusChangedAt'>,
): Date | null {
  switch (app.status) {
    case 'IN_PROGRESS':
      return app.endDate;
    case 'TERMINATED':
      return app.actualEndDate;
    case 'REEVALUATION_REQUESTED':
      return bangkokToday(app.statusChangedAt);
    default:
      return null;
  }
}

/** รัน Guard ตามลำดับในตาราง — คืน error ตัวแรกที่ไม่ผ่าน หรือ `null` เมื่อผ่านทั้งหมด */
export function checkGuards(
  guards: readonly GuardName[],
  ctx: GuardContext,
  mode: GuardMode = 'execute',
): AppException | null {
  for (const name of guards) {
    const guard = GUARDS[name];
    if (mode === 'probe' && guard.needsInput) continue;
    const failure = guard.check(ctx);
    if (failure) return failure;
  }
  return null;
}

/** คำเตือนตอน HR ยืนยันเริ่มงาน: `end_date − actual_start_date < 30` ⇒ ไม่มีสิทธิ์ได้ใบรับรอง (UAT-35) */
export function startWarning(
  actualStartDate: Date,
  endDate: Date | null,
  minActualDays: number,
): 'NO_CERTIFICATE_ELIGIBLE' | undefined {
  if (!endDate) return undefined;
  return daysBetween(actualStartDate, endDate) < minActualDays ? 'NO_CERTIFICATE_ELIGIBLE' : undefined;
}
