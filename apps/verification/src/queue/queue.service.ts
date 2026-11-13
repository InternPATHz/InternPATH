import { Inject, Injectable } from '@nestjs/common';
import type { QueueItem } from '@prisma/client';
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
