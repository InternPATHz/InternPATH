import { randomUUID } from 'node:crypto';
import type { JwtClaims } from '@internpath/common';
import type {
  AdvisorApplicationItem,
  AdvisorDisputeItem,
  AdvisorStudentOverview,
  EvaluationView,
  Paginated,
} from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Application, Prisma } from '../../../generated/client';
import { assertAdvisorOwnership } from '../../common/auth/ownership';
import { StudentNamesService } from '../../internal/student-names.service';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationStateMachine } from '../../state-machine/application-state-machine.service';
import {
  ApplicationTransitionService,
  type TransitionCommand,
} from '../../state-machine/application-transition.service';
import { applicationNotFound, stateConflict } from '../../state-machine/errors';
import type { Actor } from '../../state-machine/status-history.writer';
import { ACADEMIC_RESULT_WITHOUT_TRANSITION } from '../../state-machine/transition-table';
import { loadSnapshotNames, toAdvisorItem, toApplicationBase } from '../applications/application-view';
import type { AcademicResultDto, AdvisorApplicationsQueryDto } from './advisor.dto';

/** action ของอาจารย์ที่รับแค่เหตุผล (บังคับ — Guard) */
export type AdvisorReasonAction = 'reject';
export type AdvisorDisputeAction = 'request-reevaluation' | 'uphold-fail';

const NO_PENDING_COMPANY_DECISION = 'NO_PENDING_COMPANY_DECISION';

/**
 * ฝั่งอาจารย์ที่ปรึกษา (api-contract §7.4, data-schema §8.1, README §5.2)
 * - ความเป็นเจ้าของเทียบ `applications.advisor_user_id` (ย้ายตาม E07 — หัวข้อ 1.11) ⇒ นอกความดูแล `403 NOT_OWNER_OF_RESOURCE` (UAT-29 ข้อ 3)
 * - การเปลี่ยนสถานะทั้งหมดผ่าน `ApplicationStateMachine` (Guard/โควตา/Cascade/Transaction/status_history/E08)
 */
@Injectable()
export class AdvisorService {
  constructor(
    private readonly db: PrismaService,
    private readonly stateMachine: ApplicationStateMachine,
    private readonly transitions: ApplicationTransitionService,
    private readonly studentNames: StudentNamesService,
  ) {}

  // ---------- GET ----------

  async list(user: JwtClaims, query: AdvisorApplicationsQueryDto): Promise<Paginated<AdvisorApplicationItem>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.ApplicationWhereInput = { advisorUserId: user.sub, ...(query.status ? { status: query.status } : {}) };
    const [rows, total] = await Promise.all([
      this.db.application.findMany({
        where,
        // ธงจากประกาศถูกตีกลับขึ้นก่อน แล้วรอนานสุดก่อน
        orderBy: [{ flaggedForAdvisor: 'desc' }, { statusChangedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.application.count({ where }),
    ]);
    return { data: await this.toItems(rows), meta: { page, page_size: pageSize, total } };
  }

  /** GET /advisor/disputes — `FAIL_DISPUTED` ของนักศึกษาในความดูแล พร้อมคำโต้แย้งที่ยังไม่ตัดสิน + ผลประเมินล่าสุด */
  async disputes(user: JwtClaims, page = 1, pageSize = 20): Promise<Paginated<AdvisorDisputeItem>> {
    const where: Prisma.ApplicationWhereInput = { advisorUserId: user.sub, status: 'FAIL_DISPUTED' };
    const [rows, total] = await Promise.all([
      this.db.application.findMany({
        where,
        orderBy: [{ statusChangedAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          failDisputes: { where: { decision: null }, orderBy: { createdAt: 'desc' }, take: 1 },
          evaluations: { orderBy: [{ round: 'desc' }, { evaluatedAt: 'desc' }], take: 1 },
        },
      }),
      this.db.application.count({ where }),
    ]);
    const items = await this.toItems(rows);
    const data = rows.flatMap((row, i): AdvisorDisputeItem[] => {
      const dispute = row.failDisputes[0];
      if (!dispute) return [];
      const evaluation = row.evaluations[0];
      return [
        {
          ...items[i],
          dispute: { id: dispute.id, statement: dispute.statement, created_at: dispute.createdAt.toISOString() },
          ...(evaluation
            ? {
                evaluation: {
                  round: evaluation.round as EvaluationView['round'],
                  result: evaluation.result,
                  ...(evaluation.reason ? { reason: evaluation.reason } : {}),
                  evaluated_at: evaluation.evaluatedAt.toISOString(),
                },
              }
            : {}),
        },
      ];
    });
    return { data, meta: { page, page_size: pageSize, total } };
  }

  /**
   * GET /advisor/students/{id}/overview — นักศึกษาต้องอยู่ในความดูแล (ผูกอยู่ใน `student_advisor_links` หรือมีใบสมัครที่ผูกกับอาจารย์คนนี้)
   * แสดงเฉพาะใบสมัครที่ `advisor_user_id` = อาจารย์คนนี้ • นอกความดูแล ⇒ 403
   */
  async overview(user: JwtClaims, studentUserId: string): Promise<AdvisorStudentOverview> {
    const [link, applications] = await Promise.all([
      this.db.studentAdvisorLink.findUnique({ where: { studentUserId } }),
      this.db.application.findMany({
        where: { studentUserId, advisorUserId: user.sub },
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
      }),
    ]);
    const linked = link?.linkStatus === 'LINKED' && link.advisorUserId === user.sub;
    if (!linked && applications.length === 0) assertAdvisorOwnership(user, null);
    const names = await loadSnapshotNames(this.db, applications);
    return {
      student_user_id: studentUserId,
      full_name: await this.studentNames.name(studentUserId),
      applications: applications.map((app) => toApplicationBase(app, names)),
    };
  }

  // ---------- Actions ----------

  /** `approve` — `ADVISOR_PENDING → ADVISOR_APPROVED`; ใบอื่นของนักศึกษาที่ `PENDING` → `WITHDRAWN` (SYSTEM) ใน Transaction เดียว */
  async approve(user: JwtClaims, applicationId: string, correlationId?: string): Promise<AdvisorApplicationItem> {
    await this.advisorApplication(user, applicationId);
    await this.execute(user, applicationId, { trigger: 'approve' }, correlationId);
    return this.item(applicationId);
  }

  /** `reject` `{reason}` บังคับ (`400 REASON_REQUIRED`) — `ADVISOR_REJECTED` + release โควตา (UAT-06) */
  async reject(user: JwtClaims, applicationId: string, reason: string | undefined, correlationId?: string): Promise<AdvisorApplicationItem> {
    await this.advisorApplication(user, applicationId);
    await this.execute(user, applicationId, { trigger: 'reject', reason }, correlationId);
    return this.item(applicationId);
  }

  /**
   * `request-reevaluation` (1 รอบ — `reevaluation_used`) / `uphold-fail` จาก `FAIL_DISPUTED`
   * บันทึกคำตัดสินลง `fail_disputes` ที่ยังไม่ตัดสินใน Transaction เดียวกัน (ทำให้หน้าต่างโต้แย้ง "จบ" ⇒ บันทึก `academic_result` ได้)
   */
  async decideDispute(
    user: JwtClaims,
    applicationId: string,
    action: AdvisorDisputeAction,
    note: string | undefined,
    correlationId?: string,
    now = new Date(),
  ): Promise<AdvisorApplicationItem> {
    await this.advisorApplication(user, applicationId);
    await this.execute(
      user,
      applicationId,
      {
        trigger: action,
        afterTransition: async (tx, after) => {
          const open = await tx.failDispute.findFirst({
            where: { applicationId: after.id, decision: null },
            orderBy: { createdAt: 'desc' },
          });
          if (!open) throw stateConflict('DISPUTE_MISSING');
          await tx.failDispute.update({
            where: { id: open.id },
            data: {
              decision: action === 'request-reevaluation' ? 'REEVALUATE' : 'UPHOLD',
              decidedBy: user.sub,
              decidedAt: now,
              decisionNote: note || null,
            },
          });
        },
      },
      correlationId,
      now,
    );
    return this.item(applicationId);
  }

  /**
   * `academic-result` `{academic_result, note?}`
   * - `EVALUATED_PASS` ⇒ ได้ทั้ง 3 ค่า; `EVALUATED_FAIL` ⇒ เฉพาะ `ACADEMIC_FAIL`/`REPEAT_REQUIRED` และหลังหน้าต่างโต้แย้ง/โต้แย้งจบ → `COMPLETED`
   * - `TERMINATED`/`NO_EVALUATION` ⇒ บันทึกผลโดยไม่เปลี่ยนสถานะ (ไม่มี status_history/E08) ได้ครั้งเดียว
   * - ห้ามเปลี่ยน FAIL ของบริษัทเป็น PASS (`400 VALIDATION_FAILED` + `COMPANY_FAIL_CANNOT_BECOME_PASS` — UAT-21)
   */
  async academicResult(
    user: JwtClaims,
    applicationId: string,
    body: AcademicResultDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<AdvisorApplicationItem> {
    const app = await this.advisorApplication(user, applicationId);
    const note = body.note || null;
    if (ACADEMIC_RESULT_WITHOUT_TRANSITION.includes(app.status)) {
      await this.db.$transaction(async (tx) => {
        const fresh = await tx.application.findUnique({ where: { id: applicationId } });
        if (!fresh) throw applicationNotFound();
        await this.transitions.recordAcademicResultWithoutTransition(tx, fresh, body.academic_result, note, now);
      });
    } else {
      await this.execute(
        user,
        applicationId,
        {
          trigger: 'academic-result',
          to: 'COMPLETED',
          input: { academicResult: body.academic_result },
          patch: { academicNote: note },
        },
        correlationId,
        now,
      );
    }
    return this.item(applicationId);
  }

  /**
   * บริษัทถูกระงับขณะฝึก — `continue` (UAT-27): บันทึก `company_suspended_decision = CONTINUE` ไม่เปลี่ยนสถานะ
   * ใช้ได้เฉพาะ `IN_PROGRESS` ที่ `company_suspended_decision = PENDING` ไม่งั้น `409 STATE_CONFLICT`
   */
  async continueInternship(user: JwtClaims, applicationId: string): Promise<AdvisorApplicationItem> {
    await this.advisorApplication(user, applicationId);
    const { count } = await this.db.application.updateMany({
      where: { id: applicationId, status: 'IN_PROGRESS', companySuspendedDecision: 'PENDING' },
      data: { companySuspendedDecision: 'CONTINUE', version: { increment: 1 } },
    });
    if (count === 0) throw stateConflict(NO_PENDING_COMPANY_DECISION);
    return this.item(applicationId);
  }

  /**
   * บริษัทถูกระงับขณะฝึก — `terminate` `{reason}` (UAT-27): `TERMINATED`, `terminated_by = ADVISOR`
   * + `company_suspended_decision = TERMINATE` ใน Transaction เดียว • ใช้ได้เฉพาะเมื่อรออาจารย์ตัดสิน (api-contract §7.4)
   */
  async terminate(user: JwtClaims, applicationId: string, reason: string | undefined, correlationId?: string): Promise<AdvisorApplicationItem> {
    const app = await this.advisorApplication(user, applicationId);
    if (app.status === 'IN_PROGRESS' && app.companySuspendedDecision !== 'PENDING') {
      throw stateConflict(NO_PENDING_COMPANY_DECISION);
    }
    await this.execute(
      user,
      applicationId,
      {
        trigger: 'terminate',
        reason,
        afterTransition: async (tx, after) => {
          const { count } = await tx.application.updateMany({
            where: { id: after.id, companySuspendedDecision: 'PENDING' },
            data: { companySuspendedDecision: 'TERMINATE' },
          });
          // `continue` ชนะไปก่อน (ไม่น่าเกิดเพราะ updateMany สถานะล็อกแถวไว้แล้ว) ⇒ rollback
          if (count === 0) throw stateConflict(NO_PENDING_COMPANY_DECISION);
        },
      },
      correlationId,
    );
    return this.item(applicationId);
  }

  // ---------- helper ----------

  private async execute(
    user: JwtClaims,
    applicationId: string,
    command: Omit<TransitionCommand, 'actor' | 'correlationId'>,
    correlationId: string | undefined,
    now = new Date(),
  ): Promise<void> {
    const actor: Actor = { userId: user.sub, role: 'ADVISOR' };
    await this.stateMachine.execute(applicationId, { ...command, actor, correlationId: correlationId ?? randomUUID() }, now);
  }

  /** ไม่มี ⇒ 404 • ไม่ใช่อาจารย์ของใบสมัคร (หรือยังไม่มีอาจารย์) ⇒ 403 `NOT_OWNER_OF_RESOURCE` */
  private async advisorApplication(user: JwtClaims, applicationId: string): Promise<Application> {
    const app = await this.db.application.findUnique({ where: { id: applicationId } });
    if (!app) throw applicationNotFound();
    assertAdvisorOwnership(user, app.advisorUserId);
    return app;
  }

  private async item(applicationId: string): Promise<AdvisorApplicationItem> {
    const app = await this.db.application.findUniqueOrThrow({ where: { id: applicationId } });
    return (await this.toItems([app]))[0];
  }

  private async toItems(rows: Application[]): Promise<AdvisorApplicationItem[]> {
    const [names, studentNames] = await Promise.all([
      loadSnapshotNames(this.db, rows),
      this.studentNames.names(rows.map((r) => r.studentUserId)),
    ]);
    return rows.map((row) => toAdvisorItem(row, names, studentNames.get(row.studentUserId) ?? ''));
  }
}
