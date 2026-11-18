import { asUuid } from '@internpath/common';
import type { ActorRole } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Tx } from '../prisma/types';

/** entity ของ `status_history` ใน lifecycle_db (data-schema §2.2, §6 — APPLICATION/CERTIFICATE/REVIEW) */
export type HistoryEntity = 'APPLICATION' | 'CERTIFICATE' | 'REVIEW';

/** ผู้กระทำ — `userId = null` เมื่อเป็น SYSTEM */
export interface Actor {
  userId: string | null;
  role: ActorRole;
}

export const SYSTEM_ACTOR: Actor = Object.freeze({ userId: null, role: 'SYSTEM' });

export interface HistoryEntry {
  entity: HistoryEntity;
  entityId: string;
  fromStatus: string | null;
  toStatus: string;
  actor: Actor;
  reason?: string | null;
  correlationId: string;
  occurredAt: Date;
}

/**
 * เขียน `status_history` (append-only — trigger ใน migration ปฏิเสธ UPDATE/DELETE)
 * ใช้ร่วมกันทั้งใบสมัคร ใบรับรอง และรีวิว (README §5.10) ต้องเรียกใน Transaction เดียวกับการเปลี่ยนสถานะ
 */
@Injectable()
export class StatusHistoryWriter {
  async record(tx: Tx, entry: HistoryEntry): Promise<void> {
    await tx.statusHistory.create({
      data: {
        entity: entry.entity,
        entityId: entry.entityId,
        fromStatus: entry.fromStatus,
        toStatus: entry.toStatus,
        actorId: entry.actor.role === 'SYSTEM' ? null : entry.actor.userId,
        actorRole: entry.actor.role,
        reason: entry.reason?.trim() ? entry.reason.trim() : null,
        correlationId: asUuid(entry.correlationId),
        occurredAt: entry.occurredAt,
      },
    });
  }
}
