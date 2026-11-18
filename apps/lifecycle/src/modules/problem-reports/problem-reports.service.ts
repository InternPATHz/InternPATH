import { OutboxWriter, asUuid } from '@internpath/common';
import type { ProblemReportCreatedPayload, ProblemReportItem } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { ProblemReport } from '../../../generated/client';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';
import { PrismaService } from '../../prisma/prisma.service';
import { applicationNotFound, stateConflict } from '../../state-machine/errors';
import { advisorNotLinked } from '../applications/apply-rules';
import type { CreateProblemReportDto } from '../applications/applications.dto';

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
}
