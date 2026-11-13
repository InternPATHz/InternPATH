import { OutboxWriter } from '@internpath/common';
import { Inject, Injectable } from '@nestjs/common';
import type { RejectionKind } from '@prisma/client';
import { asUuid } from '../common/uuid';
import { emitCompanyFlagChanged } from '../events/company-flag-changed';
import { LIMITS_CONFIG, LimitsConfig } from '../limits/limits.config';
import type { Tx } from '../prisma/types';
import { QueueService } from '../queue/queue.service';

const DAY_MS = 86_400_000;

interface FlagRow {
  under_review: boolean;
  cleared_at: Date | null;
  entity_version: number;
}

@Injectable()
export class FlagService {
  constructor(
    private readonly outbox: OutboxWriter,
    private readonly queue: QueueService,
    @Inject(LIMITS_CONFIG) private readonly limits: LimitsConfig,
  ) {}

  /**
   * บันทึกเหตุการณ์ปฏิเสธ/ระงับ/ลบของประกาศ (จาก E03) แล้วตรวจเกณฑ์ติดธง (spec §5.5) — เรียกใน Transaction ของ consumer
   * `sourceEventId` ซ้ำ = Event เดิมที่ถูกส่งซ้ำ ข้ามเงียบ; นับเฉพาะเหตุการณ์หลัง `cleared_at` ของธงและภายใน
   * `rejectionWindowDays` นับจากเวลาของเหตุการณ์นี้ (เหตุการณ์ที่ Admin เคลียร์ธงไปแล้วจะไม่ติดกลับทันที)
   */
  async recordRejection(
    tx: Tx,
    a: { companyId: string; jobId: string; kind: RejectionKind; occurredAt: Date; sourceEventId: string; correlationId: string },
  ): Promise<void> {
    const { count } = await tx.companyRejectionEvent.createMany({
      data: [{ companyId: a.companyId, jobId: a.jobId, kind: a.kind, occurredAt: a.occurredAt, sourceEventId: a.sourceEventId }],
      skipDuplicates: true,
    });
    if (count === 0) return;

    const row = await this.lockFlag(tx, a.companyId);
    if (row.under_review) return;

    const windowStart = Math.max(a.occurredAt.getTime() - this.limits.rejectionWindowDays * DAY_MS, row.cleared_at?.getTime() ?? 0);
    const n = await tx.companyRejectionEvent.count({ where: { companyId: a.companyId, occurredAt: { gt: new Date(windowStart) } } });
    if (n >= this.limits.rejectionThreshold) {
      await this.setFlag(tx, { companyId: a.companyId, active: true, setBy: 'SYSTEM', triggerCount: n, correlationId: a.correlationId });
    }
  }

  /**
   * ตั้ง/เคลียร์ธง UNDER_REVIEW ใน Transaction ของผู้เรียก (ผู้เรียกเป็นผู้เขียน admin_audit_log)
   * ค่าเดิมอยู่แล้ว ⇒ `changed=false` ไม่เขียนอะไร/ไม่ส่ง Event; เปลี่ยนจริง ⇒ entity_version+1, status_history, E18
   * ตั้งโดยระบบ ⇒ สร้างรายการ COMPANY_ACCOUNT; เคลียร์ ⇒ ปิดรายการ COMPANY_ACCOUNT ที่เปิดอยู่ (ADMIN_CLEAR_FLAG)
   */
  async setFlag(
    tx: Tx,
    a: {
      companyId: string;
      active: boolean;
      setBy: 'SYSTEM' | 'ADMIN';
      reason?: string;
      triggerCount?: number;
      adminId?: string;
      correlationId: string;
    },
  ): Promise<{ changed: boolean }> {
    const cur = await this.lockFlag(tx, a.companyId);
    if (cur.under_review === a.active) return { changed: false };

    const now = new Date();
    const version = cur.entity_version + 1;
    await tx.companyFlag.update({
      where: { companyId: a.companyId },
      data: a.active
        ? { underReview: true, setBy: a.setBy, setReason: a.reason ?? null, setAt: now, triggerCount: a.triggerCount ?? null, entityVersion: version }
        : { underReview: false, clearedBy: a.adminId ?? null, clearedAt: now, entityVersion: version },
    });
    await tx.statusHistory.create({
      data: {
        entity: 'COMPANY_FLAG',
        entityId: a.companyId,
        fromStatus: cur.under_review ? 'UNDER_REVIEW' : 'CLEAR',
        toStatus: a.active ? 'UNDER_REVIEW' : 'CLEAR',
        actorId: a.adminId ?? null,
        actorRole: a.setBy === 'ADMIN' ? 'PLATFORM_ADMIN' : 'SYSTEM',
        reason: a.reason ?? null,
        correlationId: asUuid(a.correlationId),
        occurredAt: now,
      },
    });

    if (a.active && a.setBy === 'SYSTEM') {
      await this.queue.createCompanyItem(tx, { companyId: a.companyId, origin: 'REJECTION_THRESHOLD', correlationId: a.correlationId, now });
    }
    if (!a.active) {
      const open = await this.queue.findOpenByType(tx, a.companyId, 'COMPANY_ACCOUNT');
      if (open) {
        await this.queue.resolveOpenItem(tx, {
          item: open,
          resolution: 'ADMIN_CLEAR_FLAG',
          actorId: a.adminId ?? null,
          actorRole: a.setBy === 'ADMIN' ? 'PLATFORM_ADMIN' : 'SYSTEM',
          reason: a.reason,
          correlationId: a.correlationId,
        });
      }
    }

    await emitCompanyFlagChanged(this.outbox, tx, {
      correlationId: a.correlationId,
      payload: {
        company_id: a.companyId,
        flag: 'UNDER_REVIEW',
        active: a.active,
        ...(a.active && a.triggerCount !== undefined ? { trigger_count: a.triggerCount } : {}),
        set_by: a.setBy,
        entity_version: version,
        at: now.toISOString(),
      },
    });
    return { changed: true };
  }

  /** สร้างแถวธงของบริษัทถ้ายังไม่มี แล้วล็อกแถว (FOR UPDATE) — กัน E03/คำสั่ง Admin ขนานกันตั้งธงซ้ำ */
  private async lockFlag(tx: Tx, companyId: string): Promise<FlagRow> {
    await tx.companyFlag.createMany({ data: [{ companyId }], skipDuplicates: true });
    const rows = await tx.$queryRaw<FlagRow[]>`
      SELECT under_review, cleared_at, entity_version FROM company_flags WHERE company_id = ${companyId}::uuid FOR UPDATE`;
    return rows[0];
  }
}
