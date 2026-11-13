import { EVENTS_EXCHANGE, routingKey, type ServiceName } from '@internpath/contracts';
import { Logger } from '@nestjs/common';
import type { Options } from 'amqplib';
import { buildEnvelope } from './envelope';
import type { OutboxRow } from './outbox.types';

/** ส่วนของ pg.Client/Pool ที่ relay ใช้ */
export interface RelayDb {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

/** resolve หลัง broker confirm (BrokerConnection.publish เข้ากับ interface นี้) */
export interface EventPublisher {
  publish(exchange: string, routingKey: string, body: Buffer, options: Options.Publish): Promise<void>;
}

export interface RelayLogger {
  warn(message: string): void;
  error(message: string): void;
  debug(message: string): void;
}

export interface OutboxRelayOptions {
  service: ServiceName;
  db: RelayDb;
  publisher: EventPublisher;
  batchSize?: number;
  /** รอบถัดไปเมื่อรอบนี้มีงาน (ค่าเริ่มต้น 2000 ms) */
  busyIntervalMs?: number;
  /** รอบถัดไปเมื่อไม่มีงานหรือผิดพลาด (ค่าเริ่มต้น 10000 ms) */
  idleIntervalMs?: number;
  logger?: RelayLogger;
}

const LOCK_KEY = 'internpath.outbox_relay';

export function nextRelayDelayMs(
  published: number,
  o: { busyIntervalMs: number; idleIntervalMs: number },
): number {
  return published > 0 ? o.busyIntervalMs : o.idleIntervalMs;
}

/**
 * ส่งแถว outbox_events ที่ยังไม่ publish เข้า RabbitMQ แบบ at-least-once
 * (docs/event-contract.md §3.1): ครั้งละหนึ่งตัวต่อฐานข้อมูล (advisory lock) เรียงตาม created_at
 * และหยุดทันทีที่ publish แถวใดล้มเหลวเพื่อรักษาลำดับ
 */
export class OutboxRelay {
  private readonly batchSize: number;
  private readonly busyIntervalMs: number;
  private readonly idleIntervalMs: number;
  private readonly log: RelayLogger;
  private running = false;
  private timer?: NodeJS.Timeout;
  private inflight: Promise<void> = Promise.resolve();

  constructor(private readonly o: OutboxRelayOptions) {
    this.batchSize = o.batchSize ?? 50;
    this.busyIntervalMs = o.busyIntervalMs ?? 2000;
    this.idleIntervalMs = o.idleIntervalMs ?? 10000;
    this.log = o.logger ?? new Logger(OutboxRelay.name);
  }

  /** ทำหนึ่งรอบ คืนจำนวนแถวที่ส่งสำเร็จ */
  async runOnce(): Promise<number> {
    const { db, publisher, service } = this.o;
    await db.query('BEGIN');
    try {
      const lock = await db.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [LOCK_KEY]);
      if (!lock.rows[0]?.locked) {
        await db.query('ROLLBACK');
        return 0;
      }
      const { rows } = await db.query(
        `SELECT id, type, version, aggregate_id, payload, correlation_id, created_at
           FROM outbox_events
          WHERE published_at IS NULL
          ORDER BY created_at, id
          LIMIT $1`,
        [this.batchSize],
      );
      let sent = 0;
      for (const r of rows as OutboxRow[]) {
        try {
          await publisher.publish(
            EVENTS_EXCHANGE,
            routingKey(service, r.type),
            Buffer.from(JSON.stringify(buildEnvelope(r, service))),
            {
              contentType: 'application/json',
              deliveryMode: 2,
              messageId: r.id,
              headers: { 'x-correlation-id': r.correlation_id },
            },
          );
        } catch (e) {
          // log เฉพาะ id/type/ข้อความ error — ห้ามมี payload (event-contract §1)
          this.log.warn(`publish failed for event ${r.id} (${r.type}): ${(e as Error).message}`);
          await db.query('UPDATE outbox_events SET attempts = attempts + 1 WHERE id = $1', [r.id]);
          break; // ไม่ข้ามไปแถวถัดไป เพื่อรักษาลำดับ
        }
        await db.query(
          'UPDATE outbox_events SET published_at = now(), attempts = attempts + 1 WHERE id = $1',
          [r.id],
        );
        sent++;
      }
      await db.query('COMMIT');
      return sent;
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined);
      throw e;
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  /** หยุด loop และรอรอบที่กำลังทำอยู่ให้จบ */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    await this.inflight;
  }

  private schedule(delayMs: number): void {
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.inflight = this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    let sent = 0;
    try {
      sent = await this.runOnce();
    } catch (e) {
      this.log.warn(`outbox relay run failed: ${(e as Error).message}`);
    }
    this.schedule(
      nextRelayDelayMs(sent, { busyIntervalMs: this.busyIntervalMs, idleIntervalMs: this.idleIntervalMs }),
    );
  }
}
