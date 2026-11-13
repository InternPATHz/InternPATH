import { randomUUID } from 'node:crypto';
import { AppException, JwtClaims, OutboxWriter } from '@internpath/common';
import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { lockScope } from '../common/locks';
import { emitReportThresholdReached } from '../events/report-threshold';
import { LIMITS_CONFIG, LimitsConfig } from '../limits/limits.config';
import { PrismaService } from '../prisma/prisma.service';
import type { Tx } from '../prisma/types';
import { QueueService } from '../queue/queue.service';
import { startOfBangkokDay, startOfNextBangkokDay } from './bangkok-day';
import type { ReportDto } from './dto';

const REPORTABLE_STATUSES: ReadonlySet<string> = new Set(['PUBLISHED', 'CLOSED']);

/** 429: เกินโควตารายวัน — controller ตั้ง Retry-After จาก `retryAfterSeconds` */
export class RateLimitedException extends AppException {
  constructor(public readonly retryAfterSeconds: number) {
    super('RATE_LIMITED', 'รายงานได้ไม่เกินจำนวนที่กำหนดต่อวัน กรุณาลองใหม่พรุ่งนี้', 429);
  }
}

@Injectable()
export class ReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
    @Inject(LIMITS_CONFIG) private readonly limits: LimitsConfig,
  ) {}

  /**
   * นักศึกษารายงานประกาศ (spec §5.3) ลำดับตรวจ: ประกาศมีอยู่/รายงานได้ → ซ้ำ → โควตารายวัน → บันทึก
   * ตัวนับ + ระงับ (E04) + รายการคิว ทำใน Transaction เดียว; ห้าม log `detail`
   * ผลตอบกลับไม่บอกว่ารายงานนับเข้าเกณฑ์หรือไม่ (กันผู้รายงานรู้ว่าตัวเองถูกจำกัด)
   */
  report(jobId: string, dto: ReportDto, user: JwtClaims, correlationId?: string, now = new Date()): Promise<{ id: string; status: 'OPEN' }> {
    const cid = correlationId ?? randomUUID();
    return this.prisma.$transaction(async (tx) => {
      // เรียงงานของผู้ใช้เดียวกัน (โควตา 5/วัน นับแล้วค่อย insert) และของประกาศเดียวกัน (ตัวนับ + รายการคิว + E04 +
      // คำตัดสิน Admin) ให้เข้าทีละงาน — ลำดับ user → job เสมอ (ดู lockScope)
      await lockScope(tx, 'user', user.sub);
      await lockScope(tx, 'job', jobId);
      const snapshot = await tx.jobSnapshot.findUnique({ where: { jobId } });
      if (!snapshot) throw new AppException('NOT_FOUND', 'ไม่พบประกาศงาน', 404);
      if (!REPORTABLE_STATUSES.has(snapshot.status)) {
        throw new AppException('JOB_NOT_REPORTABLE', 'ประกาศนี้ไม่อยู่ในสถานะที่รายงานได้', 422);
      }

      const existing = await tx.jobReport.findUnique({ where: { jobId_reporterUserId: { jobId, reporterUserId: user.sub } }, select: { id: true } });
      if (existing) throw new AppException('ALREADY_REPORTED', 'คุณรายงานประกาศนี้ไปแล้ว', 409);

      const today = await tx.jobReport.count({ where: { reporterUserId: user.sub, createdAt: { gte: startOfBangkokDay(now) } } });
      if (today >= this.limits.reportDailyLimit) {
        throw new RateLimitedException(Math.max(1, Math.ceil((startOfNextBangkokDay(now).getTime() - now.getTime()) / 1000)));
      }

      const stats = await tx.reporterStat.findUnique({ where: { userId: user.sub } });
      const counted = (stats?.consecutiveDismissed ?? 0) < this.limits.reporterDismissStreak;

      let report;
      try {
        report = await tx.jobReport.create({
          data: { jobId, reporterUserId: user.sub, category: dto.category, detail: dto.detail, counted, status: 'OPEN', createdAt: now },
        });
      } catch (e) {
        if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002') {
          throw new AppException('ALREADY_REPORTED', 'คุณรายงานประกาศนี้ไปแล้ว', 409);
        }
        throw e;
      }

      if (counted) {
        // upsert แบบ atomic: Transaction ขนานกันต่อแถวเดียวกันจะเข้าคิวรอกัน จึงได้ค่า counted_reports ไม่ซ้ำกัน
        const [row] = await tx.$queryRaw<Array<{ counted_reports: number }>>`
          INSERT INTO job_report_counters (job_id, counted_reports) VALUES (${jobId}::uuid, 1)
          ON CONFLICT (job_id) DO UPDATE SET counted_reports = job_report_counters.counted_reports + 1
          RETURNING counted_reports`;
        await this.suspendIfThresholdReached(tx, { jobId, companyId: snapshot.companyId, countedReports: row.counted_reports, correlationId: cid, now });
      } else if (!(await this.queue.findOpenByType(tx, jobId, 'JOB_REPORT'))) {
        // ไม่นับเข้าเกณฑ์ แต่ยังเข้าคิวให้ Admin พิจารณา (README 5.1.3)
        await this.queue.createReportItem(tx, {
          jobId,
          companyId: snapshot.companyId,
          submissionId: await this.latestSubmissionId(tx, jobId),
          origin: 'REPORT_UNCOUNTED',
          correlationId: cid,
          now,
        });
      }
      return { id: report.id, status: 'OPEN' as const };
    });
  }

  /**
   * ถ้าตัวนับครบเกณฑ์และยังไม่เคยระงับในรอบนี้ ⇒ ตั้ง `suspended_at` (conditional UPDATE — ผู้ชนะคือคนที่ได้ 1 แถวเท่านั้น)
   * แล้วสร้าง/อัปเกรดรายการ JOB_REPORT เป็น REPORT_THRESHOLD และส่ง E04 คืน true เมื่อระงับครั้งนี้
   * เรียกใน Transaction ของผู้เรียก (ใช้ซ้ำใน ReportResolutionService เมื่อ uphold ทำให้นับครบ)
   */
  async suspendIfThresholdReached(
    tx: Tx,
    a: { jobId: string; companyId: string; countedReports: number; correlationId: string; now: Date },
  ): Promise<boolean> {
    const won = await tx.$executeRaw`
      UPDATE job_report_counters SET suspended_at = ${a.now}
      WHERE job_id = ${a.jobId}::uuid AND suspended_at IS NULL AND counted_reports >= ${this.limits.reportThreshold}`;
    if (won !== 1) return false;

    const open = await this.queue.findOpenByType(tx, a.jobId, 'JOB_REPORT');
    const submissionId = open?.submissionId ?? (await this.latestSubmissionId(tx, a.jobId));
    const item = open
      ? await tx.queueItem.update({ where: { id: open.id }, data: { origin: 'REPORT_THRESHOLD', submissionId } })
      : await this.queue.createReportItem(tx, {
          jobId: a.jobId,
          companyId: a.companyId,
          submissionId,
          origin: 'REPORT_THRESHOLD',
          correlationId: a.correlationId,
          now: a.now,
        });

    await emitReportThresholdReached(this.outbox, tx, {
      correlationId: a.correlationId,
      payload: {
        job_id: a.jobId,
        company_id: a.companyId,
        report_count: a.countedReports,
        queue_item_id: item.id,
        reached_at: a.now.toISOString(),
      },
    });
    return true;
  }

  /** submission_id ของผลตรวจล่าสุด (เลือกจาก submitted_at) — ว่างถ้าประกาศไม่เคยมีผลตรวจ */
  async latestSubmissionId(tx: Tx, jobId: string): Promise<string | null> {
    const latest = await tx.evaluation.findFirst({ where: { jobId }, orderBy: { submittedAt: 'desc' }, select: { submissionId: true } });
    return latest?.submissionId ?? null;
  }
}
