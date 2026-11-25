import type { ActorRole, ApplicationStatus, TerminatedBy } from '@internpath/contracts';

/**
 * Transition Table ของใบสมัคร — แหล่งเดียวของ "จาก → ไป, ผู้กระทำ, Guard, Side effect"
 * แปลงจาก docs/data-schema.md §8.1 (ฉบับ 2026-11-17) ทีละแถว — แก้ตารางในเอกสารก่อนแล้วค่อยแก้ที่นี่
 *
 * - `trigger` = ชื่อ `{action}` ของ endpoint (api-contract §7) สำหรับผู้ใช้ หรือชื่อเหตุการณ์ของ SYSTEM
 * - คู่ (from, trigger, actor) ต้องไม่ซ้ำกัน — ทดสอบใน test/unit/state-machine/transition-table.spec.ts
 */

/** ชื่อปุ่ม/endpoint ที่ผู้ใช้กดได้ (ตรงกับ `{action}` ใน api-contract §7) */
export type UserTrigger =
  // นักศึกษา (§7.2)
  | 'confirm-offer'
  | 'decline-offer'
  | 'withdraw'
  | 'request-termination'
  | 'dispute-fail'
  // HR (§7.3)
  | 'accept'
  | 'reject'
  | 'rescind-offer'
  | 'start'
  | 'terminate'
  | 'evaluate'
  // อาจารย์ (§7.4)
  | 'approve'
  | 'request-reevaluation'
  | 'uphold-fail'
  | 'academic-result'
  // Admin (§7.7)
  | 'confirm-no-evaluation';

/** เหตุการณ์ที่ระบบเป็นผู้เปลี่ยนสถานะ (Scheduler / Consumer / Side effect ของการเปลี่ยนสถานะอื่น) */
export type SystemTrigger =
  /** หมดเวลา SLA (Scheduler — README §5.3) */
  | 'expire'
  /** นักศึกษาถูกอาจารย์อนุมัติใบอื่น ⇒ ใบที่ `PENDING` ถูกถอน */
  | 'auto-withdraw'
  /** นักศึกษายืนยันใบอื่น ⇒ ใบที่ `HR_ACCEPTED` ถูกปฏิเสธแทน */
  | 'auto-decline'
  /** ประกาศ `AUTO_REJECTED`/`ADMIN_REJECTED`/`REMOVED` (E03 `CANCEL_PRE_APPROVAL`) */
  | 'cancel-by-job'
  /** ผู้ใช้ลบบัญชี (E15, data-schema §2.3 — PM ตัดสิน 2026-11-17) */
  | 'cancel-by-deletion';

export type TransitionTrigger = UserTrigger | SystemTrigger;

/** ผลต่อโควตาของประกาศ (Internal API ของ Job — `application_id` เป็น Idempotency Key) */
export type QuotaEffect = 'RESERVE' | 'CONFIRM' | 'RELEASE' | 'NONE';

/** ชื่อ Guard — ตัวตรวจจริงอยู่ใน `guards.ts` */
export type GuardName =
  /** ต้องมีเหตุผล (`REASON_REQUIRED`) */
  | 'reasonRequired'
  /** `end_date − start_date ≥ 30` วัน (`INVALID_PERIOD_MIN_30_DAYS`) */
  | 'periodMin30Days'
  /** นักศึกษาไม่มีใบสมัครที่ `ADVISOR_PENDING`/`ADVISOR_APPROVED`/`IN_PROGRESS` อื่น */
  | 'notConfirmedElsewhere'
  /** ประกาศไม่ถูก Freeze */
  | 'notFrozen'
  /** ถึง `end_date` แล้ว (`EVALUATION_NOT_OPEN`) */
  | 'endDateReached'
  /** ฝึกจริงก่อนยุติ ≥ 30 วัน (`EVALUATION_NOT_OPEN`) */
  | 'terminatedAfterMinDays'
  /** ภายใน `evaluated_at + 7 วัน` (`DISPUTE_WINDOW_CLOSED`) */
  | 'disputeWindowOpen'
  /** หน้าต่างโต้แย้งปิดแล้ว (ใช้ก่อนบันทึก `academic_result` ของผล FAIL) */
  | 'disputeWindowClosed'
  /** ยังไม่เคยใช้สิทธิ์ประเมินซ้ำ */
  | 'reevaluationNotUsed'
  /** ค่า `academic_result` ที่บันทึกได้ตามผลของบริษัท */
  | 'academicResultAllowed'
  /** ครบ `SLA_EVALUATION_DAYS` (14 วัน, นับแบบ >=) จากวันฐานตามสถานะ — Admin ยืนยัน `NO_EVALUATION` (ดู `noEvaluationBaseDate`) */
  | 'evaluationOverdue';

/** Side effect ใน Transaction เดียวกันกับใบสมัครอื่นของนักศึกษาคนเดียวกัน */
export type Cascade =
  /** ใบอื่นที่ `HR_ACCEPTED` → `STUDENT_DECLINED` (SYSTEM) + release */
  | 'DECLINE_OTHER_OFFERS'
  /** ใบอื่นที่ `PENDING` → `WITHDRAWN` (SYSTEM) */
  | 'WITHDRAW_OTHER_PENDING';

export interface TransitionRule {
  from: ApplicationStatus;
  to: ApplicationStatus;
  trigger: TransitionTrigger;
  actors: readonly ActorRole[];
  guards: readonly GuardName[];
  quota: QuotaEffect;
  cascade?: Cascade;
}

const HR = 'COMPANY_HR' as const;
const STUDENT = 'STUDENT' as const;
const ADVISOR = 'ADVISOR' as const;
const ADMIN = 'PLATFORM_ADMIN' as const;
const SYSTEM = 'SYSTEM' as const;

function rule(
  from: ApplicationStatus,
  to: ApplicationStatus,
  trigger: TransitionTrigger,
  actors: readonly ActorRole[],
  options: { guards?: readonly GuardName[]; quota?: QuotaEffect; cascade?: Cascade } = {},
): TransitionRule {
  return {
    from,
    to,
    trigger,
    actors,
    guards: options.guards ?? [],
    quota: options.quota ?? 'NONE',
    ...(options.cascade ? { cascade: options.cascade } : {}),
  };
}

const RELEASE = { quota: 'RELEASE' } as const;
const WITH_REASON_RELEASE = { guards: ['reasonRequired'], quota: 'RELEASE' } as const;

export const TRANSITIONS: readonly TransitionRule[] = Object.freeze([
  // ---- PENDING ----
  rule('PENDING', 'HR_ACCEPTED', 'accept', [HR], {
    guards: ['notFrozen', 'notConfirmedElsewhere', 'periodMin30Days'],
    quota: 'RESERVE',
  }),
  rule('PENDING', 'HR_REJECTED', 'reject', [HR]),
  rule('PENDING', 'WITHDRAWN', 'withdraw', [STUDENT]),
  rule('PENDING', 'EXPIRED', 'expire', [SYSTEM]),
  rule('PENDING', 'WITHDRAWN', 'auto-withdraw', [SYSTEM]),
  rule('PENDING', 'CANCELLED', 'cancel-by-job', [SYSTEM]),
  rule('PENDING', 'CANCELLED', 'cancel-by-deletion', [SYSTEM]),

  // ---- HR_ACCEPTED ----
  rule('HR_ACCEPTED', 'ADVISOR_PENDING', 'confirm-offer', [STUDENT], {
    // ประกาศถูก Freeze ⇒ ใบสมัครหยุดเดินหน้าจนกว่าประกาศกลับเป็น PUBLISHED (README UAT-26) — ถอน/ปฏิเสธ/ถอนข้อเสนอยังทำได้
    guards: ['notFrozen', 'notConfirmedElsewhere'],
    cascade: 'DECLINE_OTHER_OFFERS',
  }),
  rule('HR_ACCEPTED', 'STUDENT_DECLINED', 'decline-offer', [STUDENT], RELEASE),
  rule('HR_ACCEPTED', 'STUDENT_DECLINED', 'auto-decline', [SYSTEM], RELEASE),
  rule('HR_ACCEPTED', 'EXPIRED', 'expire', [SYSTEM], RELEASE),
  rule('HR_ACCEPTED', 'OFFER_RESCINDED', 'rescind-offer', [HR], WITH_REASON_RELEASE),
  rule('HR_ACCEPTED', 'CANCELLED', 'cancel-by-job', [SYSTEM], RELEASE),
  rule('HR_ACCEPTED', 'CANCELLED', 'cancel-by-deletion', [SYSTEM], RELEASE),

  // ---- ADVISOR_PENDING ----
  rule('ADVISOR_PENDING', 'ADVISOR_APPROVED', 'approve', [ADVISOR], {
    guards: ['notFrozen'],
    cascade: 'WITHDRAW_OTHER_PENDING',
  }),
  rule('ADVISOR_PENDING', 'ADVISOR_REJECTED', 'reject', [ADVISOR], WITH_REASON_RELEASE),
  rule('ADVISOR_PENDING', 'WITHDRAWN', 'withdraw', [STUDENT], RELEASE),
  rule('ADVISOR_PENDING', 'OFFER_RESCINDED', 'rescind-offer', [HR], WITH_REASON_RELEASE),
  rule('ADVISOR_PENDING', 'CANCELLED', 'cancel-by-job', [SYSTEM], RELEASE),
  // E15 มาถึงหลังนักศึกษายืนยันข้อเสนอพร้อมกับขอลบบัญชี (หลุดการตรวจ deletion-eligibility) — PM ตัดสิน 2026-11-25
  rule('ADVISOR_PENDING', 'CANCELLED', 'cancel-by-deletion', [SYSTEM], RELEASE),

  // ---- ADVISOR_APPROVED ---- (ประกาศถูกตีกลับ ⇒ ติดธงเท่านั้น ดู FLAG_FOR_ADVISOR_STATUSES)
  rule('ADVISOR_APPROVED', 'IN_PROGRESS', 'start', [HR], { guards: ['notFrozen'], quota: 'CONFIRM' }),
  rule('ADVISOR_APPROVED', 'WITHDRAWN', 'withdraw', [STUDENT], RELEASE),
  rule('ADVISOR_APPROVED', 'OFFER_RESCINDED', 'rescind-offer', [HR], WITH_REASON_RELEASE),
  rule('ADVISOR_APPROVED', 'EXPIRED', 'expire', [SYSTEM], RELEASE),
  rule('ADVISOR_APPROVED', 'CANCELLED', 'cancel-by-deletion', [SYSTEM], RELEASE),

  // ---- IN_PROGRESS ---- (ไม่ release เพราะ confirm แล้ว)
  rule('IN_PROGRESS', 'TERMINATED', 'terminate', [HR, ADVISOR, ADMIN], { guards: ['reasonRequired'] }),
  rule('IN_PROGRESS', 'TERMINATED', 'request-termination', [STUDENT], { guards: ['reasonRequired'] }),
  rule('IN_PROGRESS', 'EVALUATED_PASS', 'evaluate', [HR], { guards: ['endDateReached'] }),
  rule('IN_PROGRESS', 'EVALUATED_FAIL', 'evaluate', [HR], { guards: ['endDateReached', 'reasonRequired'] }),
  rule('IN_PROGRESS', 'NO_EVALUATION', 'confirm-no-evaluation', [ADMIN], { guards: ['evaluationOverdue'] }),

  // ---- TERMINATED ---- (ทางเลือก: ฝึกจริง ≥ 30 วันก่อนยุติ — README 5.2.2)
  rule('TERMINATED', 'EVALUATED_PASS', 'evaluate', [HR], { guards: ['terminatedAfterMinDays'] }),
  rule('TERMINATED', 'EVALUATED_FAIL', 'evaluate', [HR], { guards: ['terminatedAfterMinDays', 'reasonRequired'] }),
  // HR ไม่ประเมินใบที่ฝึกจริง ≥ 30 วันก่อนยุติ ⇒ Admin ยืนยัน (PM ตัดสินในรีวิว PR #36)
  rule('TERMINATED', 'NO_EVALUATION', 'confirm-no-evaluation', [ADMIN], {
    guards: ['terminatedAfterMinDays', 'evaluationOverdue'],
  }),

  // ---- ประเมิน / โต้แย้ง ----
  rule('EVALUATED_FAIL', 'FAIL_DISPUTED', 'dispute-fail', [STUDENT], { guards: ['disputeWindowOpen'] }),
  rule('FAIL_DISPUTED', 'REEVALUATION_REQUESTED', 'request-reevaluation', [ADVISOR], {
    guards: ['reevaluationNotUsed'],
  }),
  rule('FAIL_DISPUTED', 'EVALUATED_FAIL', 'uphold-fail', [ADVISOR]),
  rule('REEVALUATION_REQUESTED', 'EVALUATED_PASS', 'evaluate', [HR]),
  rule('REEVALUATION_REQUESTED', 'EVALUATED_FAIL', 'evaluate', [HR], { guards: ['reasonRequired'] }),
  // HR ไม่ประเมินซ้ำ ⇒ Admin ยืนยัน ไม่ให้ค้าง (สถานะนี้บล็อกการลบบัญชี — PM ตัดสินในรีวิว PR #36)
  rule('REEVALUATION_REQUESTED', 'NO_EVALUATION', 'confirm-no-evaluation', [ADMIN], { guards: ['evaluationOverdue'] }),

  // ---- ผลวิชา ----
  rule('EVALUATED_PASS', 'COMPLETED', 'academic-result', [ADVISOR], { guards: ['academicResultAllowed'] }),
  rule('EVALUATED_FAIL', 'COMPLETED', 'academic-result', [ADVISOR], {
    guards: ['disputeWindowClosed', 'academicResultAllowed'],
  }),
]);

/**
 * การกระทำที่ "ไม่เปลี่ยนสถานะ" ตาม data-schema §8.1
 * - ประกาศถูกตีกลับ/ลบหลังอาจารย์อนุมัติ ⇒ `flagged_for_advisor = true` (รวม `IN_PROGRESS` ตาม TODO 1.11 / README 5.1.2)
 * - `TERMINATED`/`NO_EVALUATION` ⇒ อาจารย์บันทึก `academic_result` โดยไม่เปลี่ยนสถานะ
 */
export const FLAG_FOR_ADVISOR_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'ADVISOR_APPROVED',
  'IN_PROGRESS',
]);
export const ACADEMIC_RESULT_WITHOUT_TRANSITION: readonly ApplicationStatus[] = Object.freeze([
  'TERMINATED',
  'NO_EVALUATION',
]);

/** สถานะที่นับว่า "ยืนยันแล้ว" — ตรงกับ partial unique index `applications_one_active_confirmation_per_student` */
export const CONFIRMED_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'ADVISOR_PENDING',
  'ADVISOR_APPROVED',
  'IN_PROGRESS',
]);

/** สถานะที่ "ไม่ดำเนินอยู่" — ตรงกับเงื่อนไข NOT IN ของ index `applications_no_duplicate_active_per_job` */
export const INACTIVE_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'HR_REJECTED',
  'STUDENT_DECLINED',
  'ADVISOR_REJECTED',
  'OFFER_RESCINDED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
  'TERMINATED',
  'NO_EVALUATION',
  'COMPLETED',
]);

/**
 * สถานะที่บล็อกการลบบัญชี — `GET /internal/v1/users/{user_id}/deletion-eligibility` (api-contract §9, PM ตัดสิน 2026-11-17)
 * ใบสมัครที่ยังไม่ถึง `ADVISOR_PENDING` ถูก `CANCELLED` ด้วย trigger `cancel-by-deletion` แทน (data-schema §2.3)
 */
export const DELETION_BLOCKING_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'ADVISOR_PENDING',
  'ADVISOR_APPROVED',
  'IN_PROGRESS',
  'FAIL_DISPUTED',
  'REEVALUATION_REQUESTED',
]);

/** สถานะที่ Admin ยืนยัน `NO_EVALUATION` ได้ — ใช้ร่วมกับ `GET /admin/lifecycle/no-evaluation-candidates` (หัวข้อ 1.9) */
export const NO_EVALUATION_SOURCE_STATUSES: readonly ApplicationStatus[] = Object.freeze([
  'IN_PROGRESS',
  'TERMINATED',
  'REEVALUATION_REQUESTED',
]);

/** ผู้ยุติ → `terminated_by` (data-schema §2.1 `TerminatedBy`) */
export const TERMINATED_BY_ACTOR: Readonly<Partial<Record<ActorRole, TerminatedBy>>> = Object.freeze({
  COMPANY_HR: 'COMPANY',
  STUDENT: 'STUDENT',
  ADVISOR: 'ADVISOR',
  PLATFORM_ADMIN: 'ADMIN',
});

/**
 * หา rule จาก (สถานะปัจจุบัน, trigger, ผู้กระทำ) — `evaluate`/`academic-result` มีหลายปลายทาง
 * จึงต้องระบุ `to` เพื่อเลือกแถว (เช่น PASS/FAIL)
 */
export function findTransition(
  from: ApplicationStatus,
  trigger: TransitionTrigger,
  actor: ActorRole,
  to?: ApplicationStatus,
): TransitionRule | undefined {
  return TRANSITIONS.find(
    (r) => r.from === from && r.trigger === trigger && r.actors.includes(actor) && (to === undefined || r.to === to),
  );
}

/** คู่ (from, to) อยู่ในตารางสำหรับผู้กระทำนี้หรือไม่ — คู่อื่นทั้งหมดต้องถูกปฏิเสธ */
export function isTransitionAllowed(from: ApplicationStatus, to: ApplicationStatus, actor: ActorRole): boolean {
  return TRANSITIONS.some((r) => r.from === from && r.to === to && r.actors.includes(actor));
}

export function transitionsFrom(from: ApplicationStatus): TransitionRule[] {
  return TRANSITIONS.filter((r) => r.from === from);
}
