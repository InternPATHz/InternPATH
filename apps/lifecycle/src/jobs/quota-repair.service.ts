import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { ApplicationStatus } from '../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaLeaseService } from '../state-machine/quota-lease.service';
import { QuotaService } from '../state-machine/quota.service';

/** สถานะที่ถือโควตาแบบ "จองแล้วรอยืนยัน" — Job ควรเป็น `RESERVED` */
export const QUOTA_RESERVED_STATUSES: readonly ApplicationStatus[] = ['HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED'];
/** สถานะที่ยืนยันโควตาแล้ว (`start`) — Job ควรเป็น `CONFIRMED` */
export const QUOTA_CONFIRMED_STATUSES: readonly ApplicationStatus[] = ['IN_PROGRESS'];
/** ขอบเขตการซ่อม: ใบที่ยังดำเนินอยู่และถือโควตา (ใบที่จบแล้วไม่ซ่อม — ที่นั่งที่ยืนยันไปแล้วไม่ต้องไล่ตามอีก) */
export const QUOTA_REPAIR_STATUSES: readonly ApplicationStatus[] = [...QUOTA_RESERVED_STATUSES, ...QUOTA_CONFIRMED_STATUSES];

const BATCH_SIZE = 200;

/** ผลของการซ่อม 1 รอบ (ใช้ log และเทสต์) */
export interface QuotaRepairResult {
  scanned: number;
  /** Job อยู่ในสถานะที่ต้องการแล้ว (รวมกรณีที่ตรงอยู่แล้ว — reserve/confirm ซ้ำเป็น no-op) */
  synced: number;
  /** จองใหม่ไม่ได้เพราะที่นั่งถูกจองไปแล้ว — **ไม่ถือว่าซ่อมสำเร็จ** ลองใหม่รอบหน้า */
  quotaFull: number;
  /** Job ไม่ตอบ/ปฏิเสธ — ลองใหม่รอบหน้า */
  failed: number;
  /** มีคำสั่งอื่นถือ lease อยู่ หรือสถานะเปลี่ยนไประหว่างรอบ */
  skipped: number;
}

/**
 * ซ่อมโควตาฝั่ง Job ให้ตรงกับที่ Lifecycle ถืออยู่ (QIR-01 / QIR-03 — PM ตัดสิน 2026-11-19) โดย **Lifecycle เป็นฝ่ายชี้ขาด**
 *
 * `reservation-check` ของ Job ตอบได้แค่ "ควรถือโควตาหรือไม่" จึงกู้ 2 กรณีไม่ได้ ซึ่งงานนี้ทำแทน:
 * - release เก่าที่มาช้าไปปลดการจองของ accept รอบใหม่ (Job ไม่มีการจอง แต่ Lifecycle ถือ `quota_reserved = true`)
 * - confirm ล้มหลัง commit (ใบเป็น `IN_PROGRESS` แต่ Job ค้าง `RESERVED`)
 *
 * ทำโดยเรียก reserve (idempotent ขณะ `RESERVED`/`CONFIRMED`, หลัง `RELEASED` จองใหม่ — api-contract §9) แล้ว confirm เมื่อ `IN_PROGRESS`
 * - ถือ lease เดียวกับคำสั่ง accept (`QuotaLeaseService`) — ใบที่มีคำสั่งค้างอยู่ข้ามไปรอบหน้า
 * - อ่านใบซ้ำหลังได้ lease: ถ้าไม่ถือโควตาแล้ว/สถานะนอกขอบเขต ⇒ ไม่เรียก Job (ไม่จองให้ใบที่คืนไปแล้ว)
 * - ล้มรายใบไม่หยุดใบอื่น และไม่เขียนอะไรกลับ ⇒ ไม่หลอกตัวเองว่าซ่อมสำเร็จ (นับเป็น `quotaFull`/`failed` แล้ว log)
 */
@Injectable()
export class QuotaRepairService {
  private readonly logger = new Logger(QuotaRepairService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly lease: QuotaLeaseService,
    private readonly quota: QuotaService,
  ) {}

  async runOnce(): Promise<QuotaRepairResult> {
    const result: QuotaRepairResult = { scanned: 0, synced: 0, quotaFull: 0, failed: 0, skipped: 0 };
    const correlationId = randomUUID();
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db.application.findMany({
        where: { quotaReserved: true, status: { in: [...QUOTA_REPAIR_STATUSES] } },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: BATCH_SIZE,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      if (batch.length === 0) break;
      cursor = batch[batch.length - 1].id;
      for (const { id } of batch) {
        result.scanned += 1;
        try {
          const outcome = await this.repairOne(id, correlationId);
          result[outcome] += 1;
        } catch (error) {
          result.failed += 1;
          this.logger.warn(`Quota repair failed application=${id} error=${(error as Error).name}`);
        }
      }
      if (batch.length < BATCH_SIZE) break;
    }
    if (result.quotaFull || result.failed) {
      this.logger.warn(
        `Quota repair scanned=${result.scanned} synced=${result.synced} quotaFull=${result.quotaFull} failed=${result.failed} skipped=${result.skipped}`,
      );
    }
    return result;
  }

  private async repairOne(applicationId: string, correlationId: string): Promise<'synced' | 'quotaFull' | 'failed' | 'skipped'> {
    const token = await this.lease.acquire(applicationId);
    if (!token) return 'skipped';
    try {
      const fresh = await this.db.application.findUnique({
        where: { id: applicationId },
        select: { jobId: true, status: true, quotaReserved: true },
      });
      if (!fresh || !fresh.quotaReserved || !QUOTA_REPAIR_STATUSES.includes(fresh.status)) return 'skipped';
      const outcome = await this.quota.repair(
        fresh.jobId,
        applicationId,
        QUOTA_CONFIRMED_STATUSES.includes(fresh.status),
        correlationId,
      );
      return outcome === 'OK' ? 'synced' : outcome === 'QUOTA_FULL' ? 'quotaFull' : 'failed';
    } finally {
      await this.lease.release(applicationId, token);
    }
  }
}
