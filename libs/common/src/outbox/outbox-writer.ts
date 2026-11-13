import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { OutboxEventInput, OutboxJson, OutboxTx } from './outbox.types';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** เขียนแถว outbox ใน Transaction ของ Service (ห้ามส่ง RabbitMQ ตรงๆ — docs/event-contract.md §3.1) */
@Injectable()
export class OutboxWriter {
  private lastCreatedMs = 0;

  /** คืน event_id; ต้องเรียกภายใน `$transaction` เดียวกับการเปลี่ยนข้อมูล */
  async add(tx: OutboxTx, input: OutboxEventInput): Promise<string> {
    if (!UUID.test(input.aggregateId)) {
      throw new Error(`OutboxWriter: aggregateId must be a UUID (got ${JSON.stringify(input.aggregateId)})`);
    }
    const id = randomUUID();
    // correlation ID จาก header อาจไม่ใช่ UUID (correlation.ts ยอมรับ id ปลอดภัยรูปแบบอื่น)
    // แต่คอลัมน์เป็น uuid — ถ้าส่งค่าเดิมจะทำให้ Transaction ของ Service ล้ม
    const correlationId = UUID.test(input.correlationId) ? input.correlationId : randomUUID();
    await tx.outboxEvent.create({
      data: {
        id,
        type: input.type,
        version: input.version ?? 1,
        aggregateId: input.aggregateId,
        payload: input.payload as OutboxJson,
        correlationId,
        createdAt: this.nextCreatedAt(),
      },
    });
    return id;
  }

  /**
   * created_at ที่ DB ตั้งให้เอง (`@default(now())` ของ Prisma) คือเวลาเริ่ม Transaction — event หลายตัวใน Transaction เดียวกันจึงเท่ากัน
   * และ relay เรียงด้วย (created_at, id) ซึ่ง id สุ่ม ทำให้ลำดับต่อ aggregate เพี้ยน จึงกำหนดเวลาเองให้เพิ่มทีละ ≥ 1 ms
   */
  private nextCreatedAt(): Date {
    const now = Date.now();
    this.lastCreatedMs = now > this.lastCreatedMs ? now : this.lastCreatedMs + 1;
    return new Date(this.lastCreatedMs);
  }
}
