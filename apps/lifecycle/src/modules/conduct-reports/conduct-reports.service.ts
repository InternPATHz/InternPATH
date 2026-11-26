import { AppException, OutboxWriter, asUuid, type JwtClaims } from '@internpath/common';
import type { ConductReportCreatedPayload, ConductReportItem, ConductReportStatus, Paginated } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { ConductReport, Prisma } from '../../../generated/client';
import { CategoryScopeService } from '../../common/auth/category-scope.service';
import { assertAdvisorOwnership, assertCompanyOwnership } from '../../common/auth/ownership';
import { StudentNamesService } from '../../internal/student-names.service';
import { PrismaService } from '../../prisma/prisma.service';
import { applicationNotFound, stateConflict } from '../../state-machine/errors';
import { loadSnapshotNames, type SnapshotNames } from '../applications/application-view';
import type { AcknowledgeConductReportDto, CreateConductReportDto } from './conduct-reports.dto';

export const CONDUCT_REPORT_CREATED = 'ConductReportCreated';

type ReportWithApp = ConductReport & { application: { jobId: string; companyId: string } };

function toItem(row: ReportWithApp, names: SnapshotNames, studentName?: string): ConductReportItem {
  return {
    id: row.id,
    application_id: row.applicationId,
    student_user_id: row.studentUserId,
    ...(studentName ? { student_name: studentName } : {}),
    company_id: row.companyId,
    company_name: names.companyNames.get(row.application.companyId) ?? '',
    job_title: names.jobTitles.get(row.application.jobId) ?? '',
    category: row.category,
    detail: row.detail,
    status: row.status,
    ...(row.advisorNote ? { advisor_note: row.advisorNote } : {}),
    ...(row.acknowledgedAt ? { acknowledged_at: row.acknowledgedAt.toISOString() } : {}),
    created_at: row.createdAt.toISOString(),
  };
}

const WITH_APP = { application: { select: { jobId: true, companyId: true } } } as const;

/**
 * รายงานพฤติกรรมนักศึกษาจากบริษัทถึงอาจารย์ (ผู้ใช้สั่ง 2026-11-26)
 * - HR ส่งได้เฉพาะใบสมัคร `IN_PROGRESS` ของบริษัทตน (สายงานของ HR Member ตาม `CategoryScopeService`) — **ไม่เปลี่ยนสถานะใบสมัคร**
 * - ผู้รับ = อาจารย์ปัจจุบันของใบสมัคร (`applications.advisor_user_id`) • ส่ง E19 `ConductReportCreated` ให้ Notification แจ้งอาจารย์
 * - HR เห็นรายงานของบริษัทตนเอง (รวมหมายเหตุตอนอาจารย์รับทราบ) • คนละทางกับ problem_reports ที่บริษัทห้ามเห็น
 * - ห้าม log `detail`
 */
@Injectable()
export class ConductReportsService {
  constructor(
    private readonly db: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly scope: CategoryScopeService,
    private readonly studentNames: StudentNamesService,
  ) {}

  /** POST /hr/applications/{id}/conduct-reports */
  async create(
    user: JwtClaims,
    applicationId: string,
    body: CreateConductReportDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<ConductReportItem> {
    await this.hrApplication(user, applicationId, correlationId);
    const cid = asUuid(correlationId);
    const row = await this.db.$transaction(async (tx) => {
      // ล็อกแถวใบสมัคร กันสถานะเปลี่ยน (เช่น ถูกยุติ) ระหว่างตรวจกับบันทึก
      await tx.$queryRaw`SELECT id FROM applications WHERE id = ${applicationId}::uuid FOR UPDATE`;
      const app = await tx.application.findUniqueOrThrow({
        where: { id: applicationId },
        select: { id: true, status: true, advisorUserId: true, studentUserId: true, companyId: true },
      });
      if (app.status !== 'IN_PROGRESS') throw stateConflict('NOT_IN_PROGRESS');
      // ไม่มีอาจารย์ (เช่นอาจารย์ลบบัญชี) ⇒ ไม่มีผู้รับรายงาน
      if (!app.advisorUserId) {
        throw new AppException('STATE_CONFLICT', 'นักศึกษายังไม่มีอาจารย์ที่ปรึกษาในระบบ', 409, [{ issue: 'ADVISOR_NOT_LINKED' }]);
      }
      const created = await tx.conductReport.create({
        data: {
          applicationId: app.id,
          studentUserId: app.studentUserId,
          companyId: app.companyId,
          reportedBy: user.sub,
          category: body.category,
          detail: body.detail,
          createdAt: now,
        },
        include: WITH_APP,
      });
      const payload: ConductReportCreatedPayload = {
        conduct_report_id: created.id,
        application_id: app.id,
        student_user_id: app.studentUserId,
        advisor_user_id: app.advisorUserId,
        company_id: app.companyId,
        category: created.category,
        created_at: created.createdAt.toISOString(),
      };
      await this.outbox.add(tx, { type: CONDUCT_REPORT_CREATED, aggregateId: created.id, correlationId: cid, payload });
      return created;
    });
    return toItem(row, await loadSnapshotNames(this.db, [row.application]));
  }

  /** GET /hr/applications/{id}/conduct-reports — ใหม่สุดก่อน */
  async listForHr(user: JwtClaims, applicationId: string, correlationId?: string): Promise<{ data: ConductReportItem[] }> {
    await this.hrApplication(user, applicationId, correlationId);
    const rows = await this.db.conductReport.findMany({
      where: { applicationId },
      include: WITH_APP,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    const names = await loadSnapshotNames(this.db, rows.map((r) => r.application));
    return { data: rows.map((row) => toItem(row, names)) };
  }

  /** GET /advisor/conduct-reports — รายงานของใบสมัครที่ผูกกับอาจารย์คนนี้ ยังไม่รับทราบก่อน แล้วใหม่สุดก่อน */
  async listForAdvisor(
    advisorUserId: string,
    status: ConductReportStatus | undefined,
    page = 1,
    pageSize = 20,
  ): Promise<Paginated<ConductReportItem>> {
    const where: Prisma.ConductReportWhereInput = { application: { advisorUserId }, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.db.conductReport.findMany({
        where,
        include: WITH_APP,
        orderBy: [{ status: 'asc' }, { createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.conductReport.count({ where }),
    ]);
    const [names, studentNames] = await Promise.all([
      loadSnapshotNames(this.db, rows.map((r) => r.application)),
      this.studentNames.names(rows.map((r) => r.studentUserId)),
    ]);
    return {
      data: rows.map((row) => toItem(row, names, studentNames.get(row.studentUserId))),
      meta: { page, page_size: pageSize, total },
    };
  }

  /** `acknowledge` `{note?}` — `OPEN → ACKNOWLEDGED` เท่านั้น (ซ้ำ ⇒ `409 STATE_CONFLICT` + `ALREADY_ACKNOWLEDGED`) */
  async acknowledge(
    user: JwtClaims,
    reportId: string,
    body: AcknowledgeConductReportDto,
    now = new Date(),
  ): Promise<ConductReportItem> {
    const row = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM conduct_reports WHERE id = ${reportId}::uuid FOR UPDATE`;
      const report = await tx.conductReport.findUnique({
        where: { id: reportId },
        include: { application: { select: { advisorUserId: true } } },
      });
      if (!report) throw new AppException('NOT_FOUND', 'ไม่พบรายงานพฤติกรรม', 404);
      assertAdvisorOwnership(user, report.application.advisorUserId);
      if (report.status !== 'OPEN') throw stateConflict('ALREADY_ACKNOWLEDGED');
      return tx.conductReport.update({
        where: { id: report.id },
        data: { status: 'ACKNOWLEDGED', acknowledgedBy: user.sub, acknowledgedAt: now, advisorNote: body.note || null },
        include: WITH_APP,
      });
    });
    const [names, studentName] = await Promise.all([
      loadSnapshotNames(this.db, [row.application]),
      this.studentNames.names([row.studentUserId]).then((m) => m.get(row.studentUserId)),
    ]);
    return toItem(row, names, studentName);
  }

  /** ไม่มี ⇒ 404 • บริษัทอื่น ⇒ 403 `NOT_OWNER_OF_RESOURCE` • HR Member นอกสายงาน ⇒ 403 (เหมือนหน้าใบสมัครของ HR) */
  private async hrApplication(user: JwtClaims, applicationId: string, correlationId?: string): Promise<void> {
    const app = await this.db.application.findUnique({ where: { id: applicationId } });
    if (!app) throw applicationNotFound();
    assertCompanyOwnership(user, app.companyId);
    await this.scope.assertInScope(user, app, correlationId);
  }
}
