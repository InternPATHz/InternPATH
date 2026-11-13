import { Inject, Injectable } from '@nestjs/common';
import type { QueueItem, QueueItemType } from '@prisma/client';
import { asUuid } from '../common/uuid';
import type { Tx } from '../prisma/types';
import { SLA_CONFIG, SlaConfig, computeDueAt } from './sla';

export interface CreateQueueItemArgs {
  type: 'JOB_REVIEW' | 'JOB_APPEAL';
  jobId: string;
  companyId: string;
  submissionId: string | null;
  riskLevel: 'LOW' | 'MEDIUM' | 'HIGH' | null;
  fastTrack: boolean;
  origin: 'EVALUATION' | 'VERIFY_TIMEOUT' | 'APPEAL';
  now?: Date;
  correlationId?: string;
}

type JobItemType = 'JOB_REVIEW' | 'JOB_APPEAL';
const JOB_ITEM_TYPES: JobItemType[] = ['JOB_REVIEW', 'JOB_APPEAL'];

@Injectable()
export class QueueService {
  constructor(@Inject(SLA_CONFIG) private readonly sla: SlaConfig) {}

  /** สร้างรายการคิวของประกาศ (SLA ตาม priority) พร้อม status_history — เรียกภายใน Transaction ของผู้เรียก */
  async createItem(tx: Tx, a: CreateQueueItemArgs): Promise<QueueItem> {
    const now = a.now ?? new Date();
    const priority = a.fastTrack ? 'FAST_TRACK' : 'NORMAL';
    const item = await tx.queueItem.create({
      data: {
        type: a.type,
        targetType: 'job',
        targetId: a.jobId,
        companyId: a.companyId,
        submissionId: a.submissionId,
        priority,
        riskLevel: a.riskLevel,
        isAppeal: a.type === 'JOB_APPEAL',
        origin: a.origin,
        dueAt: computeDueAt(now, priority, this.sla),
        status: 'OPEN',
        createdAt: now,
      },
    });
    await tx.statusHistory.create({
      data: {
        entity: 'QUEUE_ITEM',
        entityId: item.id,
        fromStatus: null,
        toStatus: 'OPEN',
        actorId: null,
        actorRole: 'SYSTEM',
        reason: a.origin,
        correlationId: asUuid(a.correlationId),
        occurredAt: now,
      },
    });
    return item;
  }

  /**
   * รายการ JOB_REPORT ของประกาศ (รายงานครบเกณฑ์ หรือรายงานที่ไม่นับเข้าเกณฑ์) — priority NORMAL เสมอ
   * (Fast-Track ใช้เฉพาะ JOB_REVIEW/JOB_APPEAL — OD-10) due_at = created_at + SLA ปกติ
   */
  createReportItem(
    tx: Tx,
    a: {
      jobId: string;
      companyId: string;
      submissionId: string | null;
      origin: 'REPORT_THRESHOLD' | 'REPORT_UNCOUNTED';
      correlationId?: string;
      now?: Date;
    },
  ): Promise<QueueItem> {
    return this.createGenericItem(tx, {
      type: 'JOB_REPORT',
      targetType: 'job',
      targetId: a.jobId,
      companyId: a.companyId,
      submissionId: a.submissionId,
      origin: a.origin,
      correlationId: a.correlationId,
      now: a.now,
    });
  }

  /** รายการ COMPANY_ACCOUNT: ตรวจบัญชีบริษัทที่ติดธง UNDER_REVIEW (target = company_id) */
  createCompanyItem(
    tx: Tx,
    a: { companyId: string; origin: 'REJECTION_THRESHOLD' | 'ADMIN_FLAG'; correlationId?: string; now?: Date },
  ): Promise<QueueItem> {
    return this.createGenericItem(tx, {
      type: 'COMPANY_ACCOUNT',
      targetType: 'company',
      targetId: a.companyId,
      companyId: a.companyId,
      submissionId: null,
      origin: a.origin,
      correlationId: a.correlationId,
      now: a.now,
    });
  }

  private async createGenericItem(
    tx: Tx,
    a: {
      type: 'JOB_REPORT' | 'COMPANY_ACCOUNT';
      targetType: 'job' | 'company';
      targetId: string;
      companyId: string;
      submissionId: string | null;
      origin: 'REPORT_THRESHOLD' | 'REPORT_UNCOUNTED' | 'REJECTION_THRESHOLD' | 'ADMIN_FLAG';
      correlationId?: string;
      now?: Date;
    },
  ): Promise<QueueItem> {
    const now = a.now ?? new Date();
    const item = await tx.queueItem.create({
      data: {
        type: a.type,
        targetType: a.targetType,
        targetId: a.targetId,
        companyId: a.companyId,
        submissionId: a.submissionId,
        priority: 'NORMAL',
        isAppeal: false,
        origin: a.origin,
        dueAt: computeDueAt(now, 'NORMAL', this.sla),
        status: 'OPEN',
        createdAt: now,
      },
    });
    await tx.statusHistory.create({
      data: {
        entity: 'QUEUE_ITEM',
        entityId: item.id,
        fromStatus: null,
        toStatus: 'OPEN',
        actorId: null,
        actorRole: 'SYSTEM',
        reason: a.origin,
        correlationId: asUuid(a.correlationId),
        occurredAt: now,
      },
    });
    return item;
  }

  /** รายการเปิดของ (target, type) หนึ่งๆ — ใช้กับ JOB_REPORT / COMPANY_ACCOUNT */
  findOpenByType(tx: Tx, targetId: string, type: QueueItemType): Promise<QueueItem | null> {
    return tx.queueItem.findFirst({ where: { targetId, type, status: { not: 'RESOLVED' } }, orderBy: { createdAt: 'asc' } });
  }

  /**
   * ปิดรายการเป็น RESOLVED แบบ `updateMany where status <> 'RESOLVED'` (กันปิดซ้อน/กดพร้อมกัน) + status_history
   * คืน false ถ้ารายการถูกปิดไปก่อนแล้ว (ไม่เขียนอะไร)
   */
  async resolveOpenItem(
    tx: Tx,
    a: {
      item: QueueItem;
      resolution: string;
      actorId: string | null;
      actorRole: 'SYSTEM' | 'PLATFORM_ADMIN';
      reason?: string;
      correlationId?: string;
    },
  ): Promise<boolean> {
    const now = new Date();
    const { count } = await tx.queueItem.updateMany({
      where: { id: a.item.id, status: { not: 'RESOLVED' } },
      data: { status: 'RESOLVED', resolution: a.resolution, resolvedAt: now },
    });
    if (count === 0) return false;
    await tx.statusHistory.create({
      data: {
        entity: 'QUEUE_ITEM',
        entityId: a.item.id,
        fromStatus: a.item.status,
        toStatus: 'RESOLVED',
        actorId: a.actorId,
        actorRole: a.actorRole,
        reason: a.reason ?? null,
        correlationId: asUuid(a.correlationId),
        occurredAt: now,
      },
    });
    return true;
  }

  /** รายการคิวที่ยังเปิดอยู่ของประกาศ (ระบุ type เพื่อจำกัด; ไม่ระบุ = JOB_REVIEW หรือ JOB_APPEAL) */
  findOpenItem(tx: Tx, jobId: string, type?: JobItemType): Promise<QueueItem | null> {
    return tx.queueItem.findFirst({
      where: { targetId: jobId, type: type ?? { in: JOB_ITEM_TYPES }, status: { not: 'RESOLVED' } },
      orderBy: { createdAt: 'asc' },
    });
  }

  /**
   * ปิดรายการเปิดทั้งหมดของประกาศเป็น RESOLVED ด้วย resolution = reason โดยไม่ส่ง Event
   * (ใช้เมื่อประกาศถูกส่งตรวจรอบใหม่ — รายการเก่าไม่มีความหมายแล้ว) คืนจำนวนที่ปิด
   */
  async supersedeOpenItems(tx: Tx, jobId: string, reason: 'SUPERSEDED', correlationId?: string): Promise<number> {
    const open = await tx.queueItem.findMany({ where: { targetId: jobId, type: { in: JOB_ITEM_TYPES }, status: { not: 'RESOLVED' } } });
    let closed = 0;
    const now = new Date();
    for (const item of open) {
      const { count } = await tx.queueItem.updateMany({
        where: { id: item.id, status: { not: 'RESOLVED' } },
        data: { status: 'RESOLVED', resolution: reason, resolvedAt: now },
      });
      if (count === 0) continue;
      closed++;
      await tx.statusHistory.create({
        data: {
          entity: 'QUEUE_ITEM',
          entityId: item.id,
          fromStatus: item.status,
          toStatus: 'RESOLVED',
          actorId: null,
          actorRole: 'SYSTEM',
          reason,
          correlationId: asUuid(correlationId),
          occurredAt: now,
        },
      });
    }
    return closed;
  }
}
