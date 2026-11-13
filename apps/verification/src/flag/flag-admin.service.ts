import { randomUUID } from 'node:crypto';
import { AppException } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { Page, skipOf } from '../common/pagination';
import { PrismaService } from '../prisma/prisma.service';
import { QueueService } from '../queue/queue.service';
import { FlagListQuery } from './dto';
import { FlagService } from './flag.service';

export interface FlagListItem {
  company_id: string;
  company_name: string | null;
  active: boolean;
  set_by: string | null;
  set_reason: string | null;
  set_at: Date | null;
  cleared_at: Date | null;
  trigger_count: number | null;
}

/** การกระทำของ Admin ต่อธง UNDER_REVIEW: ตั้ง/เคลียร์ด้วยมือ, เคลียร์จากคิว, ดูรายการ (spec §5.5) */
@Injectable()
export class FlagAdminService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FlagService,
    private readonly queue: QueueService,
    private readonly audit: AuditService,
  ) {}

  /** ตั้ง/เคลียร์ธงด้วยมือ — ตั้งเองไม่สร้างรายการคิว; ค่าเดิมอยู่แล้ว ⇒ changed=false ไม่เขียน audit/Event */
  async set(
    companyId: string,
    a: { active: boolean; reason: string },
    admin: { sub: string },
    correlationId?: string,
  ): Promise<{ company_id: string; active: boolean; changed: boolean }> {
    const cid = correlationId ?? randomUUID();
    const changed = await this.prisma.$transaction(async (tx) => {
      const r = await this.flags.setFlag(tx, { companyId, active: a.active, setBy: 'ADMIN', reason: a.reason, adminId: admin.sub, correlationId: cid });
      if (r.changed) {
        await this.audit.record(tx, {
          adminId: admin.sub,
          action: a.active ? 'FLAG_SET' : 'FLAG_CLEAR',
          targetType: 'company_flag',
          targetId: companyId,
          before: { under_review: !a.active },
          after: { under_review: a.active },
          reason: a.reason,
          correlationId: cid,
        });
      }
      return r.changed;
    });
    return { company_id: companyId, active: a.active, changed };
  }

  /**
   * action `company-clear-flag` ของรายการ COMPANY_ACCOUNT: ปิดรายการก่อน (updateMany เป็นตัวกันกดพร้อมกัน → 409)
   * แล้วเคลียร์ธง (+ E18 + audit)
   */
  async clearFromQueue(itemId: string, reason: string | undefined, admin: { sub: string }, correlationId?: string): Promise<void> {
    const cid = correlationId ?? randomUUID();
    await this.prisma.$transaction(async (tx) => {
      const item = await tx.queueItem.findUnique({ where: { id: itemId } });
      if (!item) throw new AppException('NOT_FOUND', 'ไม่พบรายการคิว', 404);
      if (item.type !== 'COMPANY_ACCOUNT') {
        throw new AppException('UNSUPPORTED_ITEM_TYPE', 'รายการชนิดนี้ไม่ใช่การตรวจบัญชีบริษัท', 422);
      }
      if (item.status === 'RESOLVED') throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);

      const closed = await this.queue.resolveOpenItem(tx, {
        item, resolution: 'ADMIN_CLEAR_FLAG', actorId: admin.sub, actorRole: 'PLATFORM_ADMIN', reason, correlationId: cid,
      });
      if (!closed) throw new AppException('STATE_CONFLICT', 'รายการนี้ถูกตัดสินไปแล้ว', 409);

      await this.flags.setFlag(tx, {
        companyId: item.targetId, active: false, setBy: 'ADMIN', reason: reason ?? 'ADMIN_CLEAR_FLAG', adminId: admin.sub, correlationId: cid,
      });
      await this.audit.record(tx, {
        adminId: admin.sub,
        action: 'FLAG_CLEAR',
        targetType: 'company_flag',
        targetId: item.targetId,
        before: { under_review: true, queue_item_id: itemId },
        after: { under_review: false },
        reason,
        correlationId: cid,
      });
    });
  }

  /** รายการธงที่เคยถูกตั้ง (ไม่รวมบริษัทที่ไม่เคยติดธง) เรียงที่ตั้งล่าสุดก่อน */
  async list(q: FlagListQuery): Promise<Page<FlagListItem>> {
    const and: Prisma.CompanyFlagWhereInput[] = [{ setAt: { not: null } }];
    if (q.active !== undefined) and.push({ underReview: q.active });
    if (q.q) {
      const matches = await this.prisma.companySnapshot.findMany({
        where: { name: { contains: q.q, mode: 'insensitive' } },
        select: { companyId: true },
      });
      and.push({ companyId: { in: matches.map((m) => m.companyId) } });
    }
    const where: Prisma.CompanyFlagWhereInput = { AND: and };
    const [rows, total] = await Promise.all([
      this.prisma.companyFlag.findMany({ where, orderBy: { setAt: 'desc' }, skip: skipOf(q), take: q.page_size }),
      this.prisma.companyFlag.count({ where }),
    ]);
    const names = new Map(
      (await this.prisma.companySnapshot.findMany({ where: { companyId: { in: rows.map((r) => r.companyId) } } })).map((s) => [s.companyId, s.name]),
    );
    return {
      data: rows.map((r) => ({
        company_id: r.companyId,
        company_name: names.get(r.companyId) ?? null,
        active: r.underReview,
        set_by: r.setBy,
        set_reason: r.setReason,
        set_at: r.setAt,
        cleared_at: r.clearedAt,
        trigger_count: r.triggerCount,
      })),
      meta: { page: q.page, page_size: q.page_size, total },
    };
  }
}
