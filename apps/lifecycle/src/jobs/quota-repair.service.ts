import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { ApplicationStatus } from '../../generated/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuotaLeaseService } from '../state-machine/quota-lease.service';
import { QuotaService } from '../state-machine/quota.service';

/**
 * สถานะที่ถือโควตาแบบ "จองแล้วรอยืนยัน" — Job ควรเป็น `RESERVED` (ตรวจทุกรอบ)
 * ทุกสถานะอื่นที่ `quota_reserved = true` = ผ่าน `start` มาแล้ว ⇒ ที่นั่งยืนยันถาวร Job ควรเป็น `CONFIRMED`
 * (transition-table: release ได้เฉพาะก่อน confirm — ใบที่ยุติ/ประเมิน/จบหลังเริ่มฝึกยังถือที่นั่งต่อ)
 */
export const QUOTA_RESERVED_STATUSES: readonly ApplicationStatus[] = ['HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED'];

/**
 * ใบที่ควรเป็น `CONFIRMED` จะถูกจด `quota_synced_at` = "ตรวจตรงกับ Job ล่าสุดเมื่อ" เมื่อซ่อม/ตรวจยืนยันแล้ว
 * **และสถานะนิ่งมาอย่างน้อยช่วงนี้** (เผื่อ release เก่าที่ค้างบนเครือข่ายมาถึงทีหลัง)
 */
export const QUOTA_SYNC_SETTLE_MS = 3_600_000;

/**
 * ไม่ข้ามการตรวจถาวร (รีวิว JR): ใบที่จดแล้วถูกตรวจซ้ำเมื่อค่าเก่ากว่านี้ — release เก่าที่มาช้าหลังจดก็ยังกู้ได้
 * งานต่อวัน = จำนวนใบที่ยืนยันที่นั่งแล้ว (เรียก Job 2 ครั้งต่อใบต่อวัน) ไม่ใช่ทุกรอบ Scheduler
 */
export const QUOTA_SYNC_RECHECK_MS = 24 * 3_600_000;

const BATCH_SIZE = 200;

/** ผลของการซ่อม 1 รอบ (ใช้ log และเทสต์) */
export interface QuotaRepairResult {
  scanned: number;
  /** Job อยู่ในสถานะที่ต้องการแล้ว (รวมกรณีที่ตรงอยู่แล้ว — reserve/confirm ซ้ำเป็น no-op) */
  synced: number;
  /** จองใหม่ไม่ได้เพราะที่นั่งถูกจองไปแล้ว = **จองเกินจริง** — ไม่ถือว่าซ่อมสำเร็จ (log error) ลองใหม่รอบหน้า */
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
 * ขอบเขต: **ทุกใบที่ `quota_reserved = true`** (รวม `TERMINATED`/หลังประเมิน — ที่นั่งที่ยืนยันแล้วต้องคงอยู่ใน Job ถาวร)
 * - สถานะก่อน `start` (`QUOTA_RESERVED_STATUSES`) ⇒ reserve ซ้ำ ตรวจทุกรอบ
 * - สถานะอื่น ⇒ reserve ซ้ำ + confirm จนยืนยันตรงแล้วจด `quota_synced_at` (สถานะนิ่ง ≥ `QUOTA_SYNC_SETTLE_MS`)
 *   ข้ามจนกว่าค่านั้นจะเก่ากว่า `QUOTA_SYNC_RECHECK_MS` แล้วตรวจซ้ำ (ไม่ข้ามถาวร)
 * ทำโดยเรียก reserve (idempotent ขณะ `RESERVED`/`CONFIRMED`, หลัง `RELEASED` จองใหม่ — api-contract §9) แล้ว confirm เมื่อควรเป็น `CONFIRMED`
 * - ถือ lease เดียวกับคำสั่ง accept (`QuotaLeaseService`) — ใบที่มีคำสั่งค้างอยู่ข้ามไปรอบหน้า
 * - อ่านใบซ้ำหลังได้ lease: ถ้าไม่ถือโควตาแล้ว ⇒ ไม่เรียก Job (ไม่จองให้ใบที่คืนไปแล้ว)
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

  async runOnce(now = new Date()): Promise<QuotaRepairResult> {
    const result: QuotaRepairResult = { scanned: 0, synced: 0, quotaFull: 0, failed: 0, skipped: 0 };
    const correlationId = randomUUID();
    let cursor: string | undefined;
    for (;;) {
      const batch = await this.db.application.findMany({
        where: {
          quotaReserved: true,
          OR: [
            { status: { in: [...QUOTA_RESERVED_STATUSES] } },
            { quotaSyncedAt: null },
            { quotaSyncedAt: { lt: new Date(now.getTime() - QUOTA_SYNC_RECHECK_MS) } },
          ],
        },
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
          const outcome = await this.repairOne(id, correlationId, now);
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

  private async repairOne(
    applicationId: string,
    correlationId: string,
    now: Date,
  ): Promise<'synced' | 'quotaFull' | 'failed' | 'skipped'> {
    const token = await this.lease.acquire(applicationId);
    if (!token) return 'skipped';
    try {
      const fresh = await this.db.application.findUnique({
        where: { id: applicationId },
        select: { jobId: true, status: true, quotaReserved: true, quotaSyncedAt: true, statusChangedAt: true },
      });
      if (!fresh || !fresh.quotaReserved) return 'skipped';
      const confirmed = !QUOTA_RESERVED_STATUSES.includes(fresh.status);
      if (confirmed && fresh.quotaSyncedAt && now.getTime() - fresh.quotaSyncedAt.getTime() < QUOTA_SYNC_RECHECK_MS) {
        return 'skipped';
      }

      const outcome = await this.quota.repair(fresh.jobId, applicationId, confirmed, correlationId);
      if (outcome !== 'OK') return outcome === 'QUOTA_FULL' ? 'quotaFull' : 'failed';

      // ยืนยันตรงแล้วและสถานะนิ่งพอ ⇒ จดไว้ ไม่ตรวจซ้ำ (ยังไม่นิ่ง ⇒ ตรวจอีกรอบเผื่อ release เก่าตามมา)
      if (confirmed && now.getTime() - fresh.statusChangedAt.getTime() >= QUOTA_SYNC_SETTLE_MS) {
        await this.db.application.updateMany({ where: { id: applicationId }, data: { quotaSyncedAt: now } });
      }
      return 'synced';
    } finally {
      await this.lease.release(applicationId, token);
    }
  }
}
