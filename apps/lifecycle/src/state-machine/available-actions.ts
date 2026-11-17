import type { AcademicResult, ApplicationAction, Role } from '@internpath/contracts';
import { checkGuards, type GuardContext } from './guards';
import { ACADEMIC_RESULT_WITHOUT_TRANSITION, transitionsFrom, type TransitionTrigger } from './transition-table';

export interface AvailableActionsContext extends GuardContext {
  companySuspendedDecision?: 'PENDING' | 'CONTINUE' | 'TERMINATE' | null;
  academicResult?: AcademicResult | null;
}

export interface AvailableActions {
  /** ชื่อ `{action}` ของ endpoint (api-contract §7) ที่ผู้ใช้ role นี้กดได้ตอนนี้ */
  available_actions: ApplicationAction[];
  /** มีเมื่อ HR กด `accept` ไม่ได้ (เช่น `ALREADY_CONFIRMED_ELSEWHERE`, `JOB_FROZEN`) */
  accept_blocked_reason?: string;
}

/**
 * คำนวณปุ่มที่กดได้จาก Transition Table เดียวกับที่ใช้เปลี่ยนสถานะจริง (Guard แบบ probe)
 * ไม่ได้ตรวจความเป็นเจ้าของ — ผู้เรียกต้องตรวจก่อนว่าผู้ใช้มีสิทธิ์เห็นใบสมัครนี้
 */
export function computeAvailableActions(role: Role, ctx: AvailableActionsContext): AvailableActions {
  const actions = new Set<TransitionTrigger | 'continue'>();
  let acceptBlockedReason: string | undefined;

  for (const rule of transitionsFrom(ctx.application.status)) {
    if (!rule.actors.includes(role)) continue;
    // อาจารย์ใช้ `terminate` เฉพาะกรณีบริษัทถูกระงับขณะฝึก (api-contract §7.4)
    if (role === 'ADVISOR' && rule.trigger === 'terminate' && ctx.companySuspendedDecision !== 'PENDING') continue;

    const failure = checkGuards(rule.guards, ctx, 'probe');
    if (!failure) {
      actions.add(rule.trigger);
    } else if (rule.trigger === 'accept') {
      acceptBlockedReason =
        failure.code === 'ALREADY_CONFIRMED_ELSEWHERE' ? failure.code : (failure.details?.[0]?.issue ?? failure.code);
    }
  }

  if (role === 'ADVISOR') {
    if (ACADEMIC_RESULT_WITHOUT_TRANSITION.includes(ctx.application.status) && !ctx.academicResult) {
      actions.add('academic-result');
    }
    if (ctx.application.status === 'IN_PROGRESS' && ctx.companySuspendedDecision === 'PENDING') {
      actions.add('continue');
    }
  }

  return {
    available_actions: [...actions],
    ...(acceptBlockedReason && !actions.has('accept') ? { accept_blocked_reason: acceptBlockedReason } : {}),
  };
}
