import { randomUUID } from 'node:crypto';
import { asUuid, type JwtClaims } from '@internpath/common';
import type {
  ApplicationBase,
  ApplicationStatus,
  AuditLogEntry,
  CompanyLifecycleStats,
  NoEvaluationCandidate,
  Paginated,
  ReapplyUnlockResponse,
} from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma, type Application } from '../../../generated/client';
import { AUDIT_ACTIONS, recordAdminAudit, toAuditLogEntry } from '../../common/audit/admin-audit';
import { PrismaService } from '../../prisma/prisma.service';
import { ApplicationStateMachine } from '../../state-machine/application-state-machine.service';
import { lockStudentApplications, type TransitionCommand } from '../../state-machine/application-transition.service';
import { addDays, bangkokToday, daysBetween } from '../../state-machine/dates';
import { applicationNotFound, reasonRequired, stateConflict } from '../../state-machine/errors';
import { noEvaluationBaseDate } from '../../state-machine/guards';
import { ReapplyPolicy } from '../../state-machine/reapply-policy';
import { NO_EVALUATION_SOURCE_STATUSES } from '../../state-machine/transition-table';
import { formatDate, loadSnapshotNames, toApplicationBase } from '../applications/application-view';
import type { AuditLogsQueryDto } from './admin.dto';

/** `details[].issue` ของ `409 STATE_CONFLICT` เมื่อปลดล็อกสมัครซ้ำไม่ได้ */
export const REAPPLY_NOT_BLOCKED = 'REAPPLY_NOT_BLOCKED';
export const REAPPLY_ALREADY_UNLOCKED = 'REAPPLY_ALREADY_UNLOCKED';

/**
 * Admin ของ Lifecycle (api-contract §7.7, README §5.2.2/§5.10, UAT-22/38/39/40)
 * - ทุกการกระทำเขียน `admin_audit_log` (ผู้กระทำ เป้าหมาย ค่าก่อน-หลัง เหตุผล) **ใน Transaction เดียว** กับการเปลี่ยนข้อมูล
 * - การเปลี่ยนสถานะใบสมัครผ่าน `ApplicationStateMachine` เสมอ (Guard/status_history/E08 ครบ)
 * - เพิกถอนใบรับรองของ Admin อยู่ใน `CertificatesService.revokeByAdmin` (1.7) ใช้ `recordAdminAudit` ตัวเดียวกัน
 */
@Injectable()
export class AdminLifecycleService {
  constructor(
    private readonly db: PrismaService,
    private readonly stateMachine: ApplicationStateMachine,
    private readonly reapply: ReapplyPolicy,
  ) {}

  // ---------- NO_EVALUATION ----------

  /**
   * `GET no-evaluation-candidates` — ใบที่ HR ไม่ประเมินครบ `SLA_EVALUATION_DAYS` (14 วัน) นับจากวันฐานตามสถานะ
   * เงื่อนไขเดียวกับ Guard ของ `confirm-no-evaluation` ทุกข้อ (ทุกรายการในผลลัพธ์กดยืนยันได้จริง):
   * `IN_PROGRESS` = `end_date` • `TERMINATED` = `actual_end_date` + ฝึกจริง ≥ `CERT_MIN_ACTUAL_DAYS` •
   * `REEVALUATION_REQUESTED` = วัน (เวลาไทย) ของ `status_changed_at` — ดู `noEvaluationBaseDate()`
   * เรียงค้างนานสุดก่อน • กรองใน SQL เพื่อให้ Pagination/total ถูกต้อง
   */
  async noEvaluationCandidates(
    status: ApplicationStatus | undefined,
    page = 1,
    pageSize = 20,
    now = new Date(),
  ): Promise<Paginated<NoEvaluationCandidate>> {
    const config = await this.stateMachine.loadGuardConfig();
    const today = bangkokToday(now);
    const cutoff = formatDate(addDays(today, -config.noEvaluationAfterDays)) as string;
    const statuses = status ? [status] : [...NO_EVALUATION_SOURCE_STATUSES];

    const baseDate = Prisma.sql`(CASE a.status
      WHEN 'IN_PROGRESS' THEN a.end_date
      WHEN 'TERMINATED' THEN a.actual_end_date
      ELSE (a.status_changed_at AT TIME ZONE 'Asia/Bangkok')::date END)`;
    const where = Prisma.sql`a.status::text IN (${Prisma.join(statuses)})
      AND ${baseDate} <= ${cutoff}::date
      AND (a.status <> 'TERMINATED'
        OR (a.actual_start_date IS NOT NULL AND a.actual_end_date - a.actual_start_date >= ${config.minActualDays}::int))`;

    const [idRows, countRows] = await Promise.all([
      this.db.$queryRaw<Array<{ id: string }>>`
        SELECT a.id FROM applications a WHERE ${where}
        ORDER BY ${baseDate} ASC, a.id ASC
        LIMIT ${pageSize}::int OFFSET ${(page - 1) * pageSize}::int`,
      this.db.$queryRaw<Array<{ total: number }>>`SELECT count(*)::int AS total FROM applications a WHERE ${where}`,
    ]);
    const ids = idRows.map((row) => row.id);
    const rows = ids.length ? await this.db.application.findMany({ where: { id: { in: ids } } }) : [];
    const byId = new Map(rows.map((row) => [row.id, row]));
    const ordered = ids.map((id) => byId.get(id)).filter((row): row is Application => row !== undefined);
    const names = await loadSnapshotNames(this.db, ordered);

    return {
      data: ordered.map((app) => ({
        ...toApplicationBase(app, names),
        days_since_end: daysBetween(noEvaluationBaseDate(app) as Date, today),
      })),
      meta: { page, page_size: pageSize, total: countRows[0]?.total ?? 0 },
    };
  }

  /**
   * `confirm-no-evaluation` → `NO_EVALUATION` (UAT-22 ข้อ 2) — Guard `evaluationOverdue` (+ `terminatedAfterMinDays` ของ `TERMINATED`)
   * ยังไม่ครบ 14 วัน ⇒ `409 STATE_CONFLICT` + `EVALUATION_NOT_OVERDUE` • `reason` ไม่บังคับ (ผลการติดตามบริษัท)
   */
  async confirmNoEvaluation(
    user: JwtClaims,
    applicationId: string,
    reason: string | undefined,
    correlationId?: string,
    now = new Date(),
  ): Promise<ApplicationBase> {
    const cid = asUuid(correlationId);
    await this.execute(user, applicationId, {
      trigger: 'confirm-no-evaluation',
      reason,
      afterTransition: (tx, after, before) =>
        recordAdminAudit(tx, {
          adminId: user.sub,
          action: AUDIT_ACTIONS.APPLICATION_CONFIRM_NO_EVALUATION,
          targetType: 'APPLICATION',
          targetId: after.id,
          before: { status: before.status },
          after: { status: after.status },
          reason: reason?.trim() || null,
          correlationId: cid,
          occurredAt: now,
        }),
    }, cid, now);
    return this.item(applicationId);
  }

  /**
   * `terminate` `{reason}` → `TERMINATED`, `terminated_by = ADMIN` (README §5.2.2 เช่น พบว่าบริษัทหลอกลวง)
   * เฉพาะ `IN_PROGRESS` (ตาราง Transition) • `actual_end_date` = วันนี้ (เวลาไทย) • ไม่มีเหตุผล ⇒ `400 REASON_REQUIRED`
   */
  async terminate(
    user: JwtClaims,
    applicationId: string,
    reason: string | undefined,
    correlationId?: string,
    now = new Date(),
  ): Promise<ApplicationBase> {
    const cid = asUuid(correlationId);
    await this.execute(user, applicationId, {
      trigger: 'terminate',
      reason,
      afterTransition: (tx, after, before) =>
        recordAdminAudit(tx, {
          adminId: user.sub,
          action: AUDIT_ACTIONS.APPLICATION_TERMINATE,
          targetType: 'APPLICATION',
          targetId: after.id,
          before: { status: before.status },
          after: {
            status: after.status,
            terminated_by: after.terminatedBy,
            actual_end_date: formatDate(after.actualEndDate) ?? null,
          },
          reason: after.terminateReason,
          correlationId: cid,
          occurredAt: now,
        }),
    }, cid, now);
    return this.item(applicationId);
  }

  // ---------- ปลดล็อกสมัครซ้ำ ----------

  /**
   * `POST students/{user_id}/reapply-unlock` `{reason}` (UAT-40 ข้อ 2) — สร้างสิทธิ์ `reapply_unlocks` 1 แถว = สมัครได้ 1 ใบ
   * (ใช้สิทธิ์ใน `ReapplyPolicy.assertAndConsume` ตอนสมัคร — 1.4)
   * - ไม่ได้ถูกบล็อก (ไม่มี `ACADEMIC_PASS` / ไม่รู้จักนักศึกษา) ⇒ `409 STATE_CONFLICT` + `REAPPLY_NOT_BLOCKED`
   * - มีสิทธิ์ที่ยังไม่ใช้อยู่แล้ว ⇒ `409 STATE_CONFLICT` + `REAPPLY_ALREADY_UNLOCKED` (กันกดซ้ำ/พร้อมกัน — ล็อกใบสมัครของนักศึกษาคนนี้)
   */
  async reapplyUnlock(
    user: JwtClaims,
    studentUserId: string,
    rawReason: string | undefined,
    correlationId?: string,
    now = new Date(),
  ): Promise<ReapplyUnlockResponse> {
    const reason = rawReason?.trim();
    if (!reason) throw reasonRequired();
    const cid = asUuid(correlationId);

    const unlock = await this.db.$transaction(async (tx) => {
      // ล็อกแถวเดียวกับที่การสมัคร (1.4) ล็อก ⇒ ปลดล็อกซ้อน/สมัครพร้อมกันเห็นข้อมูลล่าสุดเสมอ
      await lockStudentApplications(tx, studentUserId);
      const eligibility = await this.reapply.check(tx, studentUserId);
      if (eligibility.unlockId) throw stateConflict(REAPPLY_ALREADY_UNLOCKED);
      if (!eligibility.blocked) throw stateConflict(REAPPLY_NOT_BLOCKED);

      const created = await tx.reapplyUnlock.create({
        data: { studentUserId, unlockedBy: user.sub, reason, createdAt: now },
      });
      await recordAdminAudit(tx, {
        adminId: user.sub,
        action: AUDIT_ACTIONS.REAPPLY_UNLOCK,
        targetType: 'STUDENT',
        targetId: studentUserId,
        before: { reapply_blocked: true },
        after: { reapply_blocked: false, unlock_id: created.id },
        reason,
        correlationId: cid,
        occurredAt: now,
      });
      return created;
    });
    return {
      id: unlock.id,
      student_user_id: unlock.studentUserId,
      unlocked_by: unlock.unlockedBy,
      reason: unlock.reason,
      created_at: unlock.createdAt.toISOString(),
    };
  }

  // ---------- สถิติ / Audit ----------

  /**
   * `GET company-stats/{company_id}` — สัญญาณตรวจสอบบริษัท (README §4.3)
   * `rescinded_count` = ใบที่ HR ถอนข้อเสนอ (`OFFER_RESCINDED` เป็นสถานะสิ้นสุด) •
   * `terminated_count` = ใบที่ถูกยุติกลางคันทุกผู้ยุติ (`terminated_by` ไม่ว่าง — คงอยู่แม้ประเมินต่อหลังยุติ)
   * บริษัทที่ไม่มีใบสมัคร ⇒ 0 ทั้งคู่ (ไม่ 404)
   */
  async companyStats(companyId: string): Promise<CompanyLifecycleStats> {
    const [rescinded, terminated] = await Promise.all([
      this.db.application.count({ where: { companyId, status: 'OFFER_RESCINDED' } }),
      this.db.application.count({ where: { companyId, terminatedBy: { not: null } } }),
    ]);
    return { company_id: companyId, rescinded_count: rescinded, terminated_count: terminated };
  }

  /** `GET audit-logs` — ล่าสุดก่อน • ตัวกรอง `actor`/`action`/`target_type`/`target_id`/`from`/`to` (ช่วง `occurred_at` รวมขอบ) */
  async auditLogs(query: AuditLogsQueryDto): Promise<Paginated<AuditLogEntry>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.actor ? { adminId: query.actor } : {}),
      ...(query.action ? { action: query.action } : {}),
      ...(query.target_type ? { targetType: query.target_type } : {}),
      ...(query.target_id ? { targetId: query.target_id } : {}),
      ...(query.from || query.to
        ? { occurredAt: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lte: query.to } : {}) } }
        : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.adminAuditLog.findMany({
        where,
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.adminAuditLog.count({ where }),
    ]);
    return { data: rows.map(toAuditLogEntry), meta: { page, page_size: pageSize, total } };
  }

  // ---------- helper ----------

  private async execute(
    user: JwtClaims,
    applicationId: string,
    command: Omit<TransitionCommand, 'actor' | 'correlationId'>,
    correlationId: string | undefined,
    now: Date,
  ): Promise<void> {
    await this.stateMachine.execute(
      applicationId,
      { ...command, actor: { userId: user.sub, role: 'PLATFORM_ADMIN' }, correlationId: correlationId ?? randomUUID() },
      now,
    );
  }

  private async item(applicationId: string): Promise<ApplicationBase> {
    const app = await this.db.application.findUnique({ where: { id: applicationId } });
    if (!app) throw applicationNotFound();
    return toApplicationBase(app, await loadSnapshotNames(this.db, [app]));
  }
}
