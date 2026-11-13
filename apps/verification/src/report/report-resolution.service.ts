import { randomUUID } from 'node:crypto';
import type { JobVerifiedReason } from '@internpath/contracts';
import { AppException, OutboxWriter } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import { AuditService } from '../audit/audit.service';
import { lockScope } from '../common/locks';
import { asUuid } from '../common/uuid';
import { emitJobVerified } from '../events/job-verified';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { ReportService } from './report.service';

type Kind = 'dismiss' | 'uphold';

/**
 * Admin ตัดสินรายการ JOB_REPORT (spec §5.4)
 *  - ระงับแล้ว (REPORT_THRESHOLD): dismiss ⇒ JobVerified(RESTORE) + รีเซ็ตตัวนับ; uphold ⇒ JobVerified(REMOVE)
 *  - ไม่นับ (REPORT_UNCOUNTED): dismiss ⇒ ปิดรายงาน + รีเซ็ตตัวนับ ไม่ส่ง Event; uphold ⇒ รายงานกลายเป็น counted=true
 *    แล้วคำนวณตัวนับใหม่ ถ้าครบเกณฑ์จึงระงับตามปกติ (ไม่มี manual suspend — R5-G02)
 * "รายงานของรอบนี้" = status ∈ {OPEN, UPHELD} และ created_at >= counter.reset_at
 */
@Injectable()
export class ReportResolutionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
    private readonly reports: ReportService,
  ) {}

  dismiss(itemId: string, admin: { sub: string }, reason?: string, correlationId?: string): Promise<void> {
    return this.resolve('dismiss', itemId, admin, reason, correlationId);
  }

  uphold(itemId: string, admin: { sub: string }, reason?: string, correlationId?: string): Promise<void> {
    return this.resolve('uphold', itemId, admin, reason, correlationId);
  }

  private async resolve(kind: Kind, itemId: string, admin: { sub: string }, reason: string | undefined, correlationId?: string): Promise<void> {
    const cid = correlationId ?? randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const probe = await tx.queueItem.findUnique({ where: { id: itemId }, select: { type: true, targetId: true } });
      if (!probe) throw new AppException('NOT_FOUND', 'ไม่พบรายการคิว', 404);
      if (probe.type !== 'JOB_REPORT') {
        throw new AppException('UNSUPPORTED_ITEM_TYPE', 'รายการชนิดนี้ไม่ใช่รายงานประกาศ', 422);
      }
      // เรียงกับการรายงานของประกาศเดียวกัน แล้วอ่านรายการใหม่: ถ้ามีรายงานที่ 3 อัปเกรด origin เป็น REPORT_THRESHOLD ไปก่อน
      // ต้องเห็นค่าล่าสุด ไม่เช่นนั้นจะเลือกทางตัดสินผิด (ไม่ส่ง RESTORE/REMOVE ทั้งที่ประกาศถูกระงับแล้ว)
      await lockScope(tx, 'job', probe.targetId);
      const item = await tx.queueItem.findUniqueOrThrow({ where: { id: itemId } });
      if (item.status === 'RESOLVED') throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);
      const suspended = item.origin === 'REPORT_THRESHOLD';
      if (suspended && !item.submissionId) {
        throw new AppException('SUBMISSION_UNKNOWN', 'รายการนี้ยังไม่ทราบ submission ที่ต้องตัดสิน', 422);
      }

      const now = new Date();
      const resolution = kind === 'dismiss' ? 'REPORT_DISMISSED' : 'REPORT_UPHELD';
      const closed = await this.queue.resolveOpenItem(tx, {
        item, resolution, actorId: admin.sub, actorRole: 'PLATFORM_ADMIN', reason, correlationId: cid,
      });
      if (!closed) throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);

      const jobId = item.targetId;
      const counter = await tx.jobReportCounter.findUnique({ where: { jobId } });
      const round = await tx.jobReport.findMany({
        where: { jobId, status: { in: ['OPEN', 'UPHELD'] }, createdAt: { gte: counter?.resetAt ?? new Date(0) } },
      });
      const ids = round.map((r) => r.id);
      const reporters = [...new Set(round.map((r) => r.reporterUserId))];

      if (kind === 'dismiss') {
        await tx.jobReport.updateMany({ where: { id: { in: ids } }, data: { status: 'DISMISSED', resolvedAt: now } });
        await tx.jobReportCounter.upsert({
          where: { jobId },
          create: { jobId, countedReports: 0, resetAt: now },
          update: { countedReports: 0, resetAt: now, suspendedAt: null },
        });
        for (const userId of reporters) {
          await tx.reporterStat.upsert({
            where: { userId },
            create: { userId, consecutiveDismissed: 1 },
            update: { consecutiveDismissed: { increment: 1 } },
          });
        }
        if (suspended) await this.emit(tx, item.targetId, item.submissionId!, 'RESTORE', 'REPORT_DISMISSED', reason ?? 'ผู้ดูแลระบบยกคำร้อง', cid, now);
      } else {
        await tx.jobReport.updateMany({ where: { id: { in: ids } }, data: { status: 'UPHELD', counted: true, resolvedAt: now } });
        for (const userId of reporters) {
          await tx.reporterStat.upsert({ where: { userId }, create: { userId, consecutiveDismissed: 0 }, update: { consecutiveDismissed: 0 } });
        }
        if (suspended) {
          await this.emit(tx, item.targetId, item.submissionId!, 'REMOVE', 'REPORT_UPHELD', reason ?? 'ผู้ดูแลระบบยืนยันว่าประกาศผิดกฎ', cid, now);
        } else {
          // ทุกรายงานของรอบนี้นับได้แล้ว ⇒ ตัวนับ = จำนวนรายงานของรอบ; ครบเกณฑ์ก็ระงับตามปกติ
          await tx.jobReportCounter.upsert({
            where: { jobId },
            create: { jobId, countedReports: round.length },
            update: { countedReports: round.length },
          });
          await this.reports.suspendIfThresholdReached(tx, {
            jobId, companyId: item.companyId!, countedReports: round.length, correlationId: cid, now,
          });
        }
      }

      await this.audit.record(tx, {
        adminId: admin.sub,
        action: kind === 'dismiss' ? 'REPORT_DISMISS' : 'REPORT_UPHOLD',
        targetType: 'queue_item',
        targetId: itemId,
        before: { status: item.status },
        after: { status: 'RESOLVED', resolution },
        reason,
        correlationId: cid,
      });
    });
  }

  private emit(
    tx: Parameters<typeof emitJobVerified>[1],
    jobId: string,
    submissionId: string,
    decision: 'RESTORE' | 'REMOVE',
    code: string,
    detail: string,
    correlationId: string,
    now: Date,
  ): Promise<string> {
    const reasons: JobVerifiedReason[] = [{ code, detail }];
    return emitJobVerified(this.outbox, tx, {
      correlationId: asUuid(correlationId),
      payload: { job_id: jobId, submission_id: submissionId, decision, reasons, is_appeal: false, decided_by: 'ADMIN', decided_at: now.toISOString() },
    });
  }
}
