import { AppException, OutboxWriter, asUuid, type JwtClaims } from '@internpath/common';
import type { Paginated, ProblemReportCreatedPayload, ProblemReportItem, ProblemReportStatus } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Prisma, ProblemReport } from '../../../generated/client';
import { assertAdvisorOwnership } from '../../common/auth/ownership';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Tx } from '../../prisma/types';
import { applicationNotFound, stateConflict } from '../../state-machine/errors';
import { advisorNotLinked } from '../applications/apply-rules';
import type { CreateProblemReportDto } from '../applications/applications.dto';
import type { ResolveProblemReportDto } from './problem-reports.dto';

export const PROBLEM_REPORT_CREATED = 'ProblemReportCreated';

const HOUR_MS = 3_600_000;

export function toProblemReportItem(row: ProblemReport, now = new Date()): ProblemReportItem {
  return {
    id: row.id,
    application_id: row.applicationId,
    student_user_id: row.studentUserId,
    category: row.category,
    detail: row.detail,
    status: row.status,
    overdue: row.status !== 'RESOLVED' && row.dueAt.getTime() < now.getTime(),
    due_at: row.dueAt.toISOString(),
    ...(row.resolutionNote ? { resolution_note: row.resolutionNote } : {}),
    ...(row.followUpAction ? { follow_up_action: row.followUpAction } : {}),
    created_at: row.createdAt.toISOString(),
  };
}

/**
 * รายงานปัญหาระหว่างฝึกงาน — ฝั่งนักศึกษา (api-contract §7.2, README §5.2.2)
 * - เฉพาะใบสมัคร `IN_PROGRESS` ของตน; **ไม่เปลี่ยนสถานะใบสมัคร** (ไม่มี status_history/E08)
 * - ส่ง `ProblemReportCreated` (E17) ถึงอาจารย์ + Admin — **บริษัท/HR ห้ามเห็น** (ไม่มี Query/API ฝั่ง HR)
 * - `due_at = created_at + PROBLEM_REPORT_SLA_HOURS` (48 ชม.)
 * - ห้าม log `detail`
 */
@Injectable()
export class ProblemReportsService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: LifecycleConfigService,
    private readonly outbox: OutboxWriter,
  ) {}

  async create(
    studentUserId: string,
    applicationId: string,
    body: CreateProblemReportDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<ProblemReportItem> {
    const slaHours = await this.config.getNumber('PROBLEM_REPORT_SLA_HOURS');
    const cid = asUuid(correlationId);

    const report = await this.db.$transaction(async (tx) => {
      // ล็อกแถวใบสมัคร กันสถานะเปลี่ยน (เช่น ถูกยุติ) ระหว่างตรวจกับบันทึก
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const app = await tx.application.findFirst({
        where: { id: applicationId, studentUserId },
        select: { id: true, status: true, advisorUserId: true },
      });
      if (!app) throw applicationNotFound();
      if (app.status !== 'IN_PROGRESS') throw stateConflict('NOT_IN_PROGRESS');
      // ผูกอาจารย์ตั้งแต่ตอนสมัคร (ADVISOR_NOT_LINKED) — E17 ต้องมี advisor_user_id
      if (!app.advisorUserId) throw advisorNotLinked();

      const row = await tx.problemReport.create({
        data: {
          applicationId: app.id,
          studentUserId,
          advisorUserId: app.advisorUserId,
          category: body.category,
          detail: body.detail,
          dueAt: new Date(now.getTime() + slaHours * HOUR_MS),
          createdAt: now,
        },
      });
      const payload: ProblemReportCreatedPayload = {
        problem_report_id: row.id,
        application_id: app.id,
        student_user_id: studentUserId,
        advisor_user_id: app.advisorUserId,
        category: row.category,
        created_at: row.createdAt.toISOString(),
      };
      await this.outbox.add(tx, { type: PROBLEM_REPORT_CREATED, aggregateId: row.id, correlationId: cid, payload });
      return row;
    });

    return toProblemReportItem(report, now);
  }

  // ---------- อาจารย์ / Admin (api-contract §7.4 — 1.6) ----------

  /** GET /advisor/problem-reports — รายงานของใบสมัครที่ผูกกับอาจารย์คนนี้ (`applications.advisor_user_id` ย้ายตาม E07) */
  async listForAdvisor(
    advisorUserId: string,
    status: ProblemReportStatus | undefined,
    page = 1,
    pageSize = 20,
    now = new Date(),
  ): Promise<Paginated<ProblemReportItem>> {
    const where: Prisma.ProblemReportWhereInput = {
      application: { advisorUserId },
      ...(status ? { status } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.problemReport.findMany({
        where,
        orderBy: [{ dueAt: 'asc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.problemReport.count({ where }),
    ]);
    return { data: rows.map((row) => toProblemReportItem(row, now)), meta: { page, page_size: pageSize, total } };
  }

  /** `acknowledge` — `OPEN → ACKNOWLEDGED` เท่านั้น (ไม่ย้อน — data-schema) ไม่งั้น `409 STATE_CONFLICT` + `NOT_OPEN` */
  async acknowledge(user: JwtClaims, reportId: string, now = new Date()): Promise<ProblemReportItem> {
    return this.db.$transaction(async (tx) => {
      const report = await this.lockForReviewer(tx, user, reportId);
      if (report.status !== 'OPEN') throw stateConflict('NOT_OPEN');
      const row = await tx.problemReport.update({
        where: { id: report.id },
        data: { status: 'ACKNOWLEDGED', acknowledgedBy: user.sub, acknowledgedAt: now },
      });
      return toProblemReportItem(row, now);
    });
  }

  /**
   * `resolve` `{note, follow_up_action?}` — จาก `OPEN` หรือ `ACKNOWLEDGED` → `RESOLVED` (จาก `OPEN` ตั้ง acknowledged ไปด้วย)
   * `RESOLVED` แล้ว ⇒ `409 STATE_CONFLICT` + `ALREADY_RESOLVED` • `follow_up_action` บันทึกอย่างเดียว ไม่เปลี่ยนสถานะใบสมัครเอง
   */
  async resolve(user: JwtClaims, reportId: string, body: ResolveProblemReportDto, now = new Date()): Promise<ProblemReportItem> {
    return this.db.$transaction(async (tx) => {
      const report = await this.lockForReviewer(tx, user, reportId);
      if (report.status === 'RESOLVED') throw stateConflict('ALREADY_RESOLVED');
      const row = await tx.problemReport.update({
        where: { id: report.id },
        data: {
          status: 'RESOLVED',
          ...(report.acknowledgedAt ? {} : { acknowledgedBy: user.sub, acknowledgedAt: now }),
          resolvedBy: user.sub,
          resolvedAt: now,
          resolutionNote: body.note,
          followUpAction: body.follow_up_action ?? null,
        },
      });
      return toProblemReportItem(row, now);
    });
  }

  /**
   * ล็อกแถวรายงาน แล้วตรวจสิทธิ์: Admin ได้ทุกรายงาน • อาจารย์ต้องเป็น `advisor_user_id` ปัจจุบันของใบสมัคร ไม่งั้น 403
   * ไม่มี ⇒ 404 (HR ถูกกันที่ `@Roles` ก่อนถึงตรงนี้ — README §5.11)
   */
  private async lockForReviewer(tx: Tx, user: JwtClaims, reportId: string): Promise<ProblemReport> {
    await tx.$queryRaw`SELECT id FROM problem_reports WHERE id = ${reportId}::uuid FOR UPDATE`;
    const report = await tx.problemReport.findUnique({
      where: { id: reportId },
      include: { application: { select: { advisorUserId: true } } },
    });
    if (!report) throw new AppException('NOT_FOUND', 'ไม่พบรายงานปัญหา', 404);
    if (user.role !== 'PLATFORM_ADMIN') assertAdvisorOwnership(user, report.application.advisorUserId);
    return report;
  }
}
