import { OutboxWriter, asUuid } from '@internpath/common';
import type { AcademicResult, ApplicationStatus } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Application, Prisma } from '../../generated/client';
import { APPLICATION_STATUS_CHANGED, buildApplicationStatusChanged } from '../events/producers/application-status-changed';
import type { Tx } from '../prisma/types';
import { bangkokToday } from './dates';
import { mapApplicationUniqueViolation, stateConflict, validationFailed } from './errors';
import { allowedAcademicResults, checkGuards, type GuardConfig, type GuardContext, type GuardInput } from './guards';
import { StatusHistoryWriter, SYSTEM_ACTOR, type Actor } from './status-history.writer';
import {
  ACADEMIC_RESULT_WITHOUT_TRANSITION,
  CONFIRMED_STATUSES,
  FLAG_FOR_ADVISOR_STATUSES,
  TERMINATED_BY_ACTOR,
  findTransition,
  type Cascade,
  type GuardName,
  type TransitionRule,
  type TransitionTrigger,
} from './transition-table';

/** คอลัมน์ที่ endpoint ส่งมาเพิ่มได้ (นอกเหนือจากที่ State Machine ตั้งเองตาม rule) */
export interface ApplicationPatch {
  startDate?: Date;
  endDate?: Date;
  actualStartDate?: Date;
  actualEndDate?: Date;
  academicNote?: string | null;
}

export interface TransitionCommand {
  trigger: TransitionTrigger;
  actor: Actor;
  /** ต้องระบุเมื่อ trigger มีหลายปลายทาง (`evaluate` → PASS/FAIL) */
  to?: ApplicationStatus;
  reason?: string;
  correlationId: string;
  /** ข้อมูลที่ Guard ใช้ (ช่วงฝึก, academic_result) */
  input?: Omit<GuardInput, 'reason'>;
  patch?: ApplicationPatch;
  hrUserIds?: string[];
  /**
   * เขียนแถวที่เกี่ยวข้อง (เช่น evaluations, fail_disputes, admin_audit_log) ใน Transaction เดียวกัน หลังเปลี่ยนสถานะสำเร็จ
   * `before` = แถวที่อ่านใน Transaction ก่อนเปลี่ยน (ค่า "ก่อน" ของ audit log)
   */
  afterTransition?: (tx: Tx, after: Application, before: Application) => Promise<void>;
}

/** โควตาที่ต้องเรียก Job หลัง commit (Internal API idempotent ด้วย `application_id`) */
export interface PendingQuotaEffect {
  effect: 'CONFIRM' | 'RELEASE';
  jobId: string;
  applicationId: string;
  reason: string;
}

export interface TransitionOutcome {
  before: Application;
  application: Application;
  rule: TransitionRule;
  eventId: string;
  quota: PendingQuotaEffect[];
  cascaded: TransitionOutcome[];
}

const CASCADE_SOURCE: Readonly<Record<Cascade, { status: ApplicationStatus; trigger: TransitionTrigger }>> = {
  DECLINE_OTHER_OFFERS: { status: 'HR_ACCEPTED', trigger: 'auto-decline' },
  WITHDRAW_OTHER_PENDING: { status: 'PENDING', trigger: 'auto-withdraw' },
};

const DISPUTE_GUARDS: readonly GuardName[] = ['disputeWindowOpen', 'disputeWindowClosed'];

/**
 * เปลี่ยนสถานะใบสมัครภายใน Transaction ที่ผู้เรียกเปิดไว้ (ไม่เปิด/commit เอง — ใช้ได้ทั้งจาก API และ Consumer)
 * ทำครบในคราวเดียว: Guard → `updateMany where status = เดิม` → `status_history` → `outbox_events(E08)` → Cascade
 */
@Injectable()
export class ApplicationTransitionService {
  constructor(
    private readonly outbox: OutboxWriter,
    private readonly history: StatusHistoryWriter,
  ) {}

  async apply(
    tx: Tx,
    before: Application,
    command: TransitionCommand,
    now: Date,
    config: GuardConfig,
  ): Promise<TransitionOutcome> {
    const rule = findTransition(before.status, command.trigger, command.actor.role, command.to);
    if (!rule) throw stateConflict();

    if (rule.cascade || rule.guards.includes('notConfirmedElsewhere')) {
      // ตรวจ/แก้ใบสมัครหลายใบของนักศึกษาคนเดียว ⇒ ล็อกทุกใบของคนนี้ตามลำดับ id ก่อน
      // กัน deadlock (เช่น ยืนยัน 2 ข้อเสนอพร้อมกันแล้วต่างฝ่ายต่าง cascade ใบของอีกฝ่าย) และให้ Guard เห็นข้อมูลล่าสุด
      await lockStudentApplications(tx, before.studentUserId);
    }

    const ctx = await this.buildGuardContext(tx, before, rule.guards, command, now, config);
    const failure = checkGuards(rule.guards, ctx, 'execute');
    if (failure) throw failure;

    const reason = command.reason?.trim() || null;
    let count: number;
    try {
      ({ count } = await tx.application.updateMany({
        where: { id: before.id, status: before.status },
        data: this.buildUpdateData(before, rule, command, reason, now),
      }));
    } catch (error) {
      throw mapApplicationUniqueViolation(error) ?? error;
    }
    // อีกคำสั่งเปลี่ยนสถานะไปก่อนแล้ว (ผู้ชนะ 1 ราย)
    if (count === 0) throw stateConflict('STALE_STATUS');

    let after = await tx.application.findUniqueOrThrow({ where: { id: before.id } });
    if (after.frozen) {
      // ฐานนับ SLA เริ่มใหม่ ⇒ ช่วง Freeze ของสถานะใหม่เริ่มนับจากตอนนี้
      after = await tx.application.update({ where: { id: before.id }, data: { frozenAt: now } });
    }

    const correlationId = asUuid(command.correlationId);
    await this.history.record(tx, {
      entity: 'APPLICATION',
      entityId: before.id,
      fromStatus: before.status,
      toStatus: rule.to,
      actor: command.actor,
      reason,
      correlationId,
      occurredAt: now,
    });
    const eventId = await this.outbox.add(tx, {
      type: APPLICATION_STATUS_CHANGED,
      aggregateId: before.id,
      correlationId,
      payload: buildApplicationStatusChanged(after, before.status, command.actor, now, {
        reason,
        hrUserIds: command.hrUserIds,
      }),
    });

    await command.afterTransition?.(tx, after, before);

    const quota: PendingQuotaEffect[] =
      rule.quota === 'CONFIRM' || rule.quota === 'RELEASE'
        ? [{ effect: rule.quota, jobId: before.jobId, applicationId: before.id, reason: rule.to }]
        : [];
    const cascaded = rule.cascade
      ? await this.runCascade(tx, after, rule.cascade, correlationId, now, config)
      : [];

    return { before, application: after, rule, eventId, quota, cascaded };
  }

  /**
   * บันทึก `academic_result` ของ `TERMINATED`/`NO_EVALUATION` โดยไม่เปลี่ยนสถานะ (data-schema §8.1)
   * ไม่มี status_history/E08 เพราะไม่ใช่การเปลี่ยนสถานะ; บันทึกได้ครั้งเดียว
   */
  async recordAcademicResultWithoutTransition(
    tx: Tx,
    before: Application,
    academicResult: AcademicResult,
    note: string | null,
    now: Date,
  ): Promise<Application> {
    if (!ACADEMIC_RESULT_WITHOUT_TRANSITION.includes(before.status)) throw stateConflict();
    if (!allowedAcademicResults(before.status).includes(academicResult)) {
      throw validationFailed('academic_result', 'NOT_ALLOWED');
    }
    const { count } = await tx.application.updateMany({
      where: { id: before.id, status: before.status, academicResult: null },
      data: {
        academicResult,
        academicNote: note,
        academicRecordedAt: now,
        version: { increment: 1 },
      },
    });
    if (count === 0) throw stateConflict('ACADEMIC_RESULT_ALREADY_RECORDED');
    return tx.application.findUniqueOrThrow({ where: { id: before.id } });
  }

  /** ประกาศถูกตีกลับ/ลบหลังอาจารย์อนุมัติ ⇒ ติดธงให้อาจารย์ ไม่เปลี่ยนสถานะ — คืน true เมื่อมีการเปลี่ยน */
  async flagForAdvisor(tx: Tx, applicationId: string): Promise<boolean> {
    const { count } = await tx.application.updateMany({
      where: { id: applicationId, status: { in: [...FLAG_FOR_ADVISOR_STATUSES] }, flaggedForAdvisor: false },
      data: { flaggedForAdvisor: true, version: { increment: 1 } },
    });
    return count > 0;
  }

  private buildUpdateData(
    before: Application,
    rule: TransitionRule,
    command: TransitionCommand,
    reason: string | null,
    now: Date,
  ): Prisma.ApplicationUpdateManyMutationInput {
    const patch = command.patch ?? {};
    const data: Prisma.ApplicationUpdateManyMutationInput = {
      status: rule.to,
      statusChangedAt: now,
      slaPausedSeconds: 0,
      version: { increment: 1 },
      entityVersion: { increment: 1 },
      ...(patch.startDate ? { startDate: patch.startDate } : {}),
      ...(patch.endDate ? { endDate: patch.endDate } : {}),
      ...(patch.actualStartDate ? { actualStartDate: patch.actualStartDate } : {}),
      ...(patch.actualEndDate ? { actualEndDate: patch.actualEndDate } : {}),
    };

    if (rule.quota === 'RESERVE') {
      data.quotaReserved = true;
      if (command.input?.startDate) data.startDate = command.input.startDate;
      if (command.input?.endDate) data.endDate = command.input.endDate;
    }
    if (rule.quota === 'RELEASE') data.quotaReserved = false;

    switch (rule.to) {
      case 'WITHDRAWN':
        data.withdrawnReason = reason;
        break;
      case 'OFFER_RESCINDED':
        data.rescindReason = reason;
        break;
      case 'ADVISOR_REJECTED':
        data.advisorRejectReason = reason;
        break;
      case 'TERMINATED':
        data.terminatedBy = TERMINATED_BY_ACTOR[command.actor.role] ?? null;
        data.terminateReason = reason;
        data.actualEndDate = patch.actualEndDate ?? bangkokToday(now);
        break;
      case 'REEVALUATION_REQUESTED':
        data.reevaluationUsed = true;
        break;
      case 'COMPLETED':
        data.academicResult = command.input?.academicResult;
        data.academicNote = patch.academicNote ?? null;
        data.academicRecordedAt = now;
        break;
      default:
        break;
    }
    // ประเมินตามกำหนด ⇒ actual_end_date = end_date (data-schema §8.1)
    if (before.status === 'IN_PROGRESS' && (rule.to === 'EVALUATED_PASS' || rule.to === 'EVALUATED_FAIL')) {
      data.actualEndDate = before.endDate;
    }
    return data;
  }

  private async buildGuardContext(
    tx: Tx,
    before: Application,
    guards: readonly GuardName[],
    command: TransitionCommand,
    now: Date,
    config: GuardConfig,
  ): Promise<GuardContext> {
    const ctx: GuardContext = {
      application: before,
      now,
      config,
      input: { ...command.input, reason: command.reason },
    };
    if (guards.includes('notConfirmedElsewhere')) {
      ctx.studentHasOtherConfirmed = await hasOtherConfirmed(tx, before);
    }
    if (guards.some((g) => DISPUTE_GUARDS.includes(g))) {
      Object.assign(ctx, await loadDisputeContext(tx, before.id));
    }
    return ctx;
  }

  private async runCascade(
    tx: Tx,
    after: Application,
    cascade: Cascade,
    correlationId: string,
    now: Date,
    config: GuardConfig,
  ): Promise<TransitionOutcome[]> {
    const source = CASCADE_SOURCE[cascade];
    const others = await tx.application.findMany({
      where: { studentUserId: after.studentUserId, status: source.status, id: { not: after.id } },
      orderBy: { createdAt: 'asc' },
    });
    const outcomes: TransitionOutcome[] = [];
    for (const other of others) {
      outcomes.push(
        await this.apply(tx, other, { trigger: source.trigger, actor: SYSTEM_ACTOR, correlationId }, now, config),
      );
    }
    return outcomes;
  }
}

/** `SELECT … FOR UPDATE` ใบสมัครทั้งหมดของนักศึกษา เรียงตาม id (ลำดับล็อกเดียวกันทุก Transaction) */
export async function lockStudentApplications(tx: Pick<Tx, '$queryRaw'>, studentUserId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM applications WHERE student_user_id = ${studentUserId}::uuid ORDER BY id FOR UPDATE`;
}

/** มีใบสมัครอื่นของนักศึกษาที่ "ยืนยันแล้ว" (`ADVISOR_PENDING`/`ADVISOR_APPROVED`/`IN_PROGRESS`) */
export async function hasOtherConfirmed(
  db: Pick<Tx, 'application'>,
  app: Pick<Application, 'id' | 'studentUserId'>,
): Promise<boolean> {
  const count = await db.application.count({
    where: { studentUserId: app.studentUserId, status: { in: [...CONFIRMED_STATUSES] }, id: { not: app.id } },
  });
  return count > 0;
}

/** ผลประเมินล่าสุด + สถานะคำโต้แย้งหลังผลนั้น (ใช้กับ Guard หน้าต่างโต้แย้ง) */
export async function loadDisputeContext(
  db: Pick<Tx, 'evaluation' | 'failDispute'>,
  applicationId: string,
): Promise<Pick<GuardContext, 'lastEvaluatedAt' | 'disputedSinceLastEvaluation' | 'disputeResolvedSinceLastEvaluation'>> {
  const last = await db.evaluation.findFirst({
    where: { applicationId },
    orderBy: [{ round: 'desc' }, { evaluatedAt: 'desc' }],
    select: { evaluatedAt: true },
  });
  if (!last) return { lastEvaluatedAt: null, disputedSinceLastEvaluation: false, disputeResolvedSinceLastEvaluation: false };
  const disputes = await db.failDispute.findMany({
    where: { applicationId, createdAt: { gte: last.evaluatedAt } },
    select: { decision: true },
  });
  return {
    lastEvaluatedAt: last.evaluatedAt,
    disputedSinceLastEvaluation: disputes.length > 0,
    disputeResolvedSinceLastEvaluation: disputes.some((d) => d.decision !== null),
  };
}
