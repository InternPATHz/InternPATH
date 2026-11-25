import type { EventEnvelope, ServiceName } from '@internpath/contracts';
import { Logger } from '@nestjs/common';
import type { Channel, ConsumeMessage } from 'amqplib';
import type { BrokerConnection } from './broker-connection';
import {
  DEFAULT_RETRY_DELAYS_MS,
  ORIGIN_QUEUE_HEADER,
  RETRY_COUNT_HEADER,
  assertBaseTopology,
  assertConsumerTopology,
  consumerQueueName,
  retryQueueName,
} from './topology';

/** ส่วนของ Prisma tx ที่ lib ใช้เขียน processed_events (กำหนดเชิงโครงสร้าง ไม่ import Prisma) */
export interface ProcessedEventsTx {
  processedEvent: {
    createMany(args: {
      data: { eventId: string; consumer: string }[];
      skipDuplicates: true;
    }): Promise<{ count: number }>;
  };
}

export interface Subscription<Tx, P = unknown> {
  producer: ServiceName;
  type: string;
  /** เวอร์ชัน payload ที่ handler รองรับ (ค่าเริ่มต้น [1]) */
  supportedVersions?: number[];
  handler(envelope: EventEnvelope<string, P>, tx: Tx): Promise<void>;
}

export interface DeadLetterInfo {
  queue: string;
  eventId?: string;
  type?: string;
  reason: 'retries_exhausted' | 'invalid_message' | 'unsupported_version';
}

export interface EventConsumerOptions<Tx> {
  service: ServiceName;
  /** ห่อ Prisma `$transaction` ของ Service: tx เดียวกันใช้ทั้ง processed_events และ handler */
  runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  retryDelaysMs?: readonly number[];
  prefetch?: number;
  /** hook เมื่อข้อความเข้า DLQ — ถ้า throw/reject จะถูก log แล้วข้าม (ข้อความยังเข้า DLQ ตามปกติ) */
  onDeadLetter?(info: DeadLetterInfo): unknown;
  /** หน่วงก่อน subscribe ใหม่เมื่อ channel ถูกปิดแต่ broker ยังต่ออยู่ (ค่าเริ่มต้น 1000 ms) */
  resubscribeDelayMs?: number;
}

export type DeliveryOutcome =
  | { kind: 'ack' }
  | { kind: 'retry'; nextCount: number }
  | { kind: 'dead-letter'; reason: DeadLetterInfo['reason']; eventId?: string; type?: string };

/** ดึง id ของ envelope เพื่อ log (ข้อความผ่าน processDelivery แล้วจึงเป็น JSON ที่ถูกต้อง) — ค่าที่ไม่ปลอดภัยถูกแทนด้วย undefined กัน log injection */
function envelopeMeta(raw: Buffer): { eventId?: string; type?: string; correlationId?: string } {
  const safe = (v: unknown) => (typeof v === 'string' && /^[\w.:-]{1,128}$/.test(v) ? v : undefined);
  try {
    const o = JSON.parse(raw.toString('utf8')) as Record<string, unknown>;
    return { eventId: safe(o.event_id), type: safe(o.type), correlationId: safe(o.correlation_id) };
  } catch {
    return {};
  }
}

/** A handler can explicitly reject malformed input after its transaction rolls back. */
export class InvalidMessageError extends Error {}

interface ProcessArgs<Tx extends ProcessedEventsTx> {
  raw: Buffer;
  retryCount: number;
  queue: string;
  sub: Subscription<Tx>;
  runInTransaction: EventConsumerOptions<Tx>['runInTransaction'];
  maxRetries: number;
  /** ถูกเรียกเมื่อ handler/DB ล้มเหลว (ใช้ log เท่านั้น — ห้ามใส่ข้อความ error ลง log) */
  onError?: (e: Error) => void;
}

/**
 * ตัดสินผลของหนึ่ง delivery: ตรวจ envelope → กันซ้ำด้วย processed_events และเรียก handler
 * ใน Transaction เดียวกัน (docs/event-contract.md §3.2) → ack / retry / dead-letter
 */
export async function processDelivery<Tx extends ProcessedEventsTx>(
  a: ProcessArgs<Tx>,
): Promise<DeliveryOutcome> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(a.raw.toString('utf8'));
  } catch {
    return { kind: 'dead-letter', reason: 'invalid_message' };
  }
  const o = parsed as Partial<EventEnvelope> | null;
  if (
    typeof o !== 'object' ||
    o === null ||
    typeof o.event_id !== 'string' ||
    o.event_id === '' ||
    o.type !== a.sub.type ||
    typeof o.version !== 'number' ||
    !('payload' in o)
  ) {
    const eventId = typeof o === 'object' && o !== null && typeof o.event_id === 'string' ? o.event_id : undefined;
    return { kind: 'dead-letter', reason: 'invalid_message', eventId };
  }
  const envelope = o as EventEnvelope;
  if (!(a.sub.supportedVersions ?? [1]).includes(envelope.version)) {
    return { kind: 'dead-letter', reason: 'unsupported_version', eventId: envelope.event_id, type: envelope.type };
  }

  try {
    await a.runInTransaction(async (tx) => {
      const { count } = await tx.processedEvent.createMany({
        data: [{ eventId: envelope.event_id, consumer: a.queue }],
        skipDuplicates: true,
      });
      if (count === 0) return; // เคยประมวลผลแล้ว (ได้ซ้ำ) — ข้ามและ ack
      await a.sub.handler(envelope, tx);
    });
    return { kind: 'ack' };
  } catch (e) {
    if (e instanceof InvalidMessageError) {
      return { kind: 'dead-letter', reason: 'invalid_message', eventId: envelope.event_id, type: envelope.type };
    }
    a.onError?.(e as Error);
    if (a.retryCount < a.maxRetries) return { kind: 'retry', nextCount: a.retryCount + 1 };
    return { kind: 'dead-letter', reason: 'retries_exhausted', eventId: envelope.event_id, type: envelope.type };
  }
}

export type ConsumerBroker = Pick<BrokerConnection, 'onConnected' | 'isConnected' | 'createChannel' | 'publish'>;

/** header ที่ RabbitMQ ใส่เองตอน dead-letter — ไม่คัดลอกไปกับ message ที่ publish ใหม่ลง retry queue */
const BROKER_MANAGED = /^x-(death|first-death-|last-death-)/;

/**
 * อธิบาย error สำหรับ log โดยไม่ใส่ข้อความ: error ของ Prisma/DB ฝังค่าที่ใช้ใน query ไว้ในข้อความ
 * จึงอาจพาเนื้อหา Event ที่อ่อนไหวไปลง log (docs/event-contract.md §1) — log แค่ชื่อกับรหัส
 */
function describeError(e: unknown): string {
  const err = e as { name?: unknown; code?: unknown } | null;
  const name = typeof err?.name === 'string' ? err.name : 'Error';
  const code = err?.code !== undefined && err.code !== null ? ` (${String(err.code)})` : '';
  return `${name}${code}`;
}

const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class EventConsumer<Tx extends ProcessedEventsTx> {
  private readonly log = new Logger(EventConsumer.name);
  private readonly retryDelaysMs: readonly number[];
  private readonly channels = new Set<Channel>();
  private readonly timers = new Set<NodeJS.Timeout>();
  private closed = false;

  constructor(
    private readonly broker: ConsumerBroker,
    private readonly o: EventConsumerOptions<Tx>,
  ) {
    this.retryDelaysMs = o.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  /**
   * ลงทะเบียน handler; ประกาศ topology และ consume ใหม่ทุกครั้งที่ broker ต่อใหม่
   * และเมื่อ channel ถูกปิด/ยกเลิกโดย broker ทั้งที่ connection ยังอยู่
   */
  async subscribe<P>(sub: Subscription<Tx, P>): Promise<void> {
    const queue = consumerQueueName(this.o.service, sub.type);
    // live = channel ที่ consume อยู่; setting = setup กำลังทำงาน (กัน setup ซ้อนก่อนที่ live จะถูกตั้ง); timer = resubscribe ที่นัดไว้ (รวมเหลือใบเดียว)
    const state: { live?: Channel; setting?: boolean; timer?: NodeJS.Timeout } = {};

    const setup = async (): Promise<void> => {
      if (this.closed || state.live || state.setting) return; // มี subscription ใช้งานอยู่แล้ว หรือกำลังตั้งอยู่
      state.setting = true;
      try {
        await attach();
      } finally {
        state.setting = false;
      }
    };

    const attach = async (): Promise<void> => {
      const ch = await this.broker.createChannel();
      ch.on('error', (e: Error) => this.log.warn(`channel error on ${queue}: ${e.message}`));
      ch.on('close', () => {
        this.channels.delete(ch);
        if (state.live === ch) state.live = undefined;
        this.scheduleResubscribe(state, run);
      });
      try {
        await ch.prefetch(this.o.prefetch ?? 10);
        await assertBaseTopology(ch);
        await assertConsumerTopology(ch, {
          service: this.o.service,
          producer: sub.producer,
          type: sub.type,
          retryDelaysMs: this.retryDelaysMs,
        });
        await ch.consume(queue, (msg) =>
          msg ? this.onMessage(ch, queue, sub as Subscription<Tx>, msg) : this.onCancelled(ch, queue),
        );
      } catch (e) {
        await ch.close().catch(() => undefined);
        throw e;
      }
      state.live = ch;
      this.channels.add(ch);
    };

    // ไม่ reject: ล้มเหลวแล้วนัด subscribe ใหม่ (BrokerConnection แค่ log ความล้มเหลวของ callback)
    const run = async (): Promise<void> => {
      try {
        await setup();
      } catch (e) {
        this.log.error(`subscribe on ${queue} failed: ${messageOf(e)}`);
        this.scheduleResubscribe(state, run);
      }
    };

    this.broker.onConnected(run);
    if (this.broker.isConnected()) await setup();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const t of this.timers) clearTimeout(t);
    this.timers.clear();
    const all = [...this.channels];
    this.channels.clear();
    await Promise.all(all.map((c) => c.close().catch(() => undefined)));
  }

  /** ถ้า broker ไม่ได้ต่ออยู่ตอนหน่วงครบ ปล่อยให้ onConnected เป็นคน subscribe เมื่อต่อใหม่สำเร็จ */
  private scheduleResubscribe(state: { timer?: NodeJS.Timeout }, run: () => Promise<void>): void {
    // รวมเหลือ timer ใบเดียวต่อ subscription: channel ที่ setup ไม่สำเร็จนัดได้จากทั้ง handler 'close' และ catch ของ run
    if (this.closed || state.timer) return;
    const t = setTimeout(() => {
      this.timers.delete(t);
      state.timer = undefined;
      if (!this.closed && this.broker.isConnected()) void run();
    }, this.o.resubscribeDelayMs ?? 1000);
    state.timer = t;
    this.timers.add(t);
  }

  private onCancelled(ch: Channel, queue: string): Promise<void> {
    this.log.warn(`consumer on ${queue} was cancelled by the broker; resubscribing`);
    return ch.close().catch(() => undefined); // 'close' ของ channel นัด subscribe ใหม่
  }

  private async onMessage(
    ch: Channel,
    queue: string,
    sub: Subscription<Tx>,
    msg: ConsumeMessage,
  ): Promise<void> {
    try {
      const headers = msg.properties.headers ?? {};
      const retryCount = Number(headers[RETRY_COUNT_HEADER] ?? 0) || 0;
      const outcome = await processDelivery({
        raw: msg.content,
        retryCount,
        queue,
        sub,
        runInTransaction: this.o.runInTransaction,
        maxRetries: this.retryDelaysMs.length,
        // log เฉพาะชื่อ/รหัส error ไม่รวมข้อความ (กันค่าใน query ของ Prisma รั่วลง log)
        onError: (e) => this.log.warn(`handler failed on ${queue}: ${describeError(e)}`),
      });
      await this.apply(ch, queue, msg, outcome);
    } catch (e) {
      this.log.error(`unexpected failure on ${queue}: ${describeError(e)}`);
      this.safeNack(ch, msg, true);
    }
  }

  private async apply(
    ch: Channel,
    queue: string,
    msg: ConsumeMessage,
    outcome: DeliveryOutcome,
  ): Promise<void> {
    if (outcome.kind === 'ack') {
      this.safeAck(ch, msg);
      // ไล่คำขอเดียวข้าม Service ได้ (README UAT-46 ข้อ 3) — log เฉพาะ id/type ไม่ log payload (กันข้อมูลส่วนบุคคล)
      const meta = envelopeMeta(msg.content);
      this.log.log(`consumed on ${queue}: type=${meta.type ?? '-'} event=${meta.eventId ?? '-'} correlation_id=${meta.correlationId ?? '-'}`);
      return;
    }
    if (outcome.kind === 'dead-letter') {
      const info: DeadLetterInfo = {
        queue,
        eventId: outcome.eventId,
        type: outcome.type,
        reason: outcome.reason,
      };
      // log เสมอ (event-contract §3.3) แล้วค่อยเรียก hook; hook พังต้องไม่ทำให้ข้อความวน requeue
      this.log.error(`dead-lettered on ${queue}: reason=${info.reason} event=${info.eventId ?? '-'}`);
      if (this.o.onDeadLetter) {
        try {
          await this.o.onDeadLetter(info);
        } catch (e) {
          this.log.error(`onDeadLetter hook failed on ${queue}: ${describeError(e)}`);
        }
      }
      this.safeNack(ch, msg, false);
      return;
    }
    const headers: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(msg.properties.headers ?? {})) {
      if (!BROKER_MANAGED.test(k)) headers[k] = v;
    }
    headers[ORIGIN_QUEUE_HEADER] = queue;
    headers[RETRY_COUNT_HEADER] = outcome.nextCount;
    try {
      // publish ลง retry queue (default exchange) แบบ confirm ก่อน แล้วจึง ack ต้นฉบับ — ข้อความจึงไม่หาย
      await this.broker.publish('', retryQueueName(this.o.service, outcome.nextCount), msg.content, {
        headers,
        contentType: 'application/json',
        deliveryMode: 2,
        ...(msg.properties.messageId ? { messageId: msg.properties.messageId } : {}),
      });
    } catch (e) {
      this.log.error(`retry publish failed on ${queue}: ${messageOf(e)}`);
      this.safeNack(ch, msg, true);
      return;
    }
    this.safeAck(ch, msg);
  }

  /** ack/nack บน channel ที่ถูกปิดจะ throw — ห้ามหลุดเป็น unhandled rejection (broker ส่งข้อความซ้ำให้เองเมื่อไม่ได้ ack) */
  private safeAck(ch: Channel, msg: ConsumeMessage): void {
    try {
      ch.ack(msg);
    } catch (e) {
      this.log.warn(`ack failed (channel closed?): ${messageOf(e)}`);
    }
  }

  private safeNack(ch: Channel, msg: ConsumeMessage, requeue: boolean): void {
    try {
      ch.nack(msg, false, requeue);
    } catch (e) {
      this.log.warn(`nack failed (channel closed?): ${messageOf(e)}`);
    }
  }
}
