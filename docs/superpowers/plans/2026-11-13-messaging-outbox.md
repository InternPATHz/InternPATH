# Messaging (Outbox relay + Consumer + Retry/DLQ) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ใส่ messaging กลางใน `libs/common` ให้ทุก Service ส่ง Event ผ่าน Outbox และรับด้วย idempotency/retry/DLQ โดยไม่ผูกกับ Prisma

**Architecture:** ผู้ส่งเรียก `OutboxWriter.add(tx, …)` ใน Prisma `$transaction` ของตัวเอง; `OutboxRelay` (ใช้ `pg`, advisory lock หนึ่งตัวต่อฐานข้อมูล) ส่งแถวเข้า `internpath.events`; `EventConsumer` รับด้วย manual ack, เขียน `processed_events` ใน Transaction เดียวกับ handler (`tx` มาจากฟังก์ชัน `runInTransaction` ที่ Service ส่งให้) retry ผ่านคิวร่วมต่อ Service (TTL) แล้วคืนคิวเดิมด้วย headers exchange, เกินแล้วเข้า DLQ

**Tech Stack:** NestJS 12, TypeScript (strict), `amqplib`, `pg`, Mocha + Chai + Sinon + c8, RabbitMQ 3.13 และ Postgres 16 ใน Docker สำหรับ integration test

**Spec:** [docs/superpowers/specs/2026-11-13-messaging-outbox-design.md](../specs/2026-11-13-messaging-outbox-design.md) (อ่านคู่กับ [event-contract.md](../../event-contract.md) §1-3 และ [data-schema.md](../../data-schema.md) §2.2)

## Global Constraints

- ทุกโค้ดอยู่ใน `libs/common/src/outbox/` และ `libs/common/src/messaging/`; export ผ่าน `libs/common/src/index.ts`; เทสต์อยู่ใต้ `libs/common/test/` (Mocha จับ `test/**/*.spec.ts`)
- `libs/common` **ห้าม import Prisma หรือ Prisma client ของ Service ใด**; รับ `tx` ผ่าน interface เชิงโครงสร้างเท่านั้น
- ใช้ชื่อ/ค่าคงที่จาก `@internpath/contracts` (`EVENTS_EXCHANGE = 'internpath.events'`, `DLX_EXCHANGE = 'internpath.dlx'`, `routingKey()`, `EventEnvelope`, `ServiceName`) ห้ามประกาศซ้ำ — `libs/common` ยัง**ไม่**ขึ้นกับ `@internpath/contracts` ต้องเพิ่ม (Task 1)
- Broker อ่านจาก `RABBITMQ_URL` อย่างเดียว (`amqp://` และ `amqps://`); ชื่อ Service และชื่อตัวแปร DB URL รับตอนตั้งค่า ไม่ hardcode
- Message: `content_type: application/json`, `delivery_mode: 2`, `message_id = event_id`, header `x-correlation-id`; Queue ผู้รับ `<consumer>.<EventType>` ผูก `<producer>.<EventType>`; DLQ `<consumer>.<EventType>.dlq`
- Retry หน่วง `5000 / 30000 / 120000` ms (ครั้งที่ 1/2/3) ใช้ **3 retry queue ร่วมต่อ Service**; เกิน 3 ครั้ง → DLQ; header `x-retry-count`
- Relay: ทุก `2000` ms เมื่อมีงาน, `10000` ms เมื่อไม่มี (ผู้เขียนเลือกค่า idle), batch `50`; ตารางตาม data-schema §2.2: `outbox_events(id, type, version, aggregate_id, payload, correlation_id, created_at, published_at, attempts)` และ `processed_events(event_id, consumer, processed_at)`
- ห้าม log payload ของ Event (มีข้อมูลอ่อนไหว เช่น `ReviewSubmitted`) log ได้เฉพาะ `event_id`, `type`, `queue`, ข้อความ error
- เช็ก API จริงของ `amqplib` ที่ติดตั้งอยู่ (`libs/common/node_modules/amqplib`) ก่อนเขียน — `health.module.ts` ใช้ `amqp.connect(url)` แบบ promise อยู่แล้ว
- **Git:** อยู่บน `main` ให้สร้าง branch `feat/messaging-outbox` ก่อน commit แรก; **ห้าม commit/push จนกว่าผู้ใช้สั่ง** — step "Commit" ให้เตรียมไฟล์ (`git add`) และเสนอข้อความ commit แล้วรอผู้ใช้
- Integration test ต้อง **ข้ามอัตโนมัติ** เมื่อต่อ RabbitMQ/Postgres ไม่ได้ ใช้ queue/exchange/schema ชื่อสุ่มต่อการรัน และ **ลบทิ้งหมดตอนจบ** (กันกิน queue quota ของ CloudAMQP)

## Review Focus

1. **Broker หลุดกลางทาง** (restart/ขาดเน็ต): ต้องต่อใหม่เอง, relay ไม่ทิ้ง Event, consumer subscribe ใหม่ — ทดสอบใน Task 2 (reconnect) และ Task 3 (publish ล้ม)
2. **Postgres ล่มขณะ relay ทำงาน**: relay ต้อง log แล้วลองใหม่ ไม่ crash process — Task 3
3. **Message เสีย** (JSON พัง, ไม่มี `event_id`, `version` ไม่รู้จัก): ส่ง DLQ ทันทีโดยไม่เรียก handler/DB และ consumer ทำงานต่อ — Task 4
4. **ได้ Event ซ้ำเพราะ ack หาย**: handler ทำงานครั้งเดียว — Task 4 และ Task 6
5. **เปิด relay สองตัวกับฐานเดียว** (สอง replica): ตัวที่สองต้องไม่ publish ซ้ำ/สลับลำดับ — Task 3
6. **`correlation_id` ที่ไม่ใช่ UUID**: middleware (`correlation.ts`) ยอมรับ id ปลอดภัยรูปแบบอื่นได้ แต่คอลัมน์ `correlation_id` เป็น `uuid` → ถ้าเขียนตรงๆ จะทำให้ Transaction ของ Service ล้ม; ต้องแทนด้วย UUID ใหม่ — Task 1

---

### Task 1: Outbox writer และ Envelope builder

**Files:**
- Modify: `libs/common/package.json` (เพิ่ม `"@internpath/contracts": "workspace:^"`), `pnpm-lock.yaml` (ผ่าน `pnpm install`), `libs/common/src/index.ts`
- Create: `libs/common/src/outbox/outbox.types.ts`, `outbox-writer.ts`, `envelope.ts`
- Test: `libs/common/test/outbox/outbox-writer.spec.ts`, `libs/common/test/outbox/envelope.spec.ts`

**Interfaces:**
- Produces:
```ts
export interface OutboxCreateData { id: string; type: string; version: number; aggregateId: string; payload: unknown; correlationId: string }
export interface OutboxTx { outboxEvent: { create(args: { data: OutboxCreateData }): Promise<unknown> } }
export interface OutboxEventInput { type: string; version?: number; aggregateId: string; correlationId: string; payload: unknown }
export class OutboxWriter { add(tx: OutboxTx, input: OutboxEventInput): Promise<string> /* resolves event_id */ }
export interface OutboxRow { id: string; type: string; version: number; aggregate_id: string; payload: unknown; correlation_id: string; created_at: Date }
export function buildEnvelope(row: OutboxRow, producer: ServiceName): EventEnvelope
```

- [ ] **Step 1:** สร้าง branch `feat/messaging-outbox`; เพิ่ม dependency ใน `package.json`; รัน `pnpm install` แล้วยืนยันว่า `pnpm --filter @internpath/common build` ยังผ่าน (contracts ถูก build ก่อนผ่าน `prepare`)
- [ ] **Step 2: เขียนเทสต์ที่ล้มก่อน** `outbox-writer.spec.ts` (ใช้ fake `tx` ที่เก็บ args):
  - `add เรียก tx.outboxEvent.create หนึ่งครั้ง ด้วย id เป็น UUID v4, version เริ่มต้น 1 และคืน id เดียวกัน`
  - `ใช้ correlationId เดิมถ้าเป็น UUID`
  - `แทน correlationId ที่ไม่ใช่ UUID (เช่น 'abc-123') ด้วย UUID ใหม่ แทนที่จะส่งค่าเดิมเข้า DB`
  - `ปฏิเสธเมื่อ aggregateId ว่าง/ไม่ใช่ UUID ก่อนเรียก tx` (error ชัดเจน ไม่แตะ DB)

  `envelope.spec.ts`: `ฟิลด์ตรงตาม event-contract §1` (`event_id=id`, `type`, `version`, `occurred_at = created_at.toISOString()`, `correlation_id`, `producer`, `payload` ไม่ถูกแก้)
- [ ] **Step 3:** รัน `pnpm --filter @internpath/common test` — คาดว่า FAIL (ยังไม่มีโมดูล)
- [ ] **Step 4:** Implement ตาม Interfaces; สร้าง UUID ด้วย `node:crypto` `randomUUID`; export จาก `src/index.ts`
- [ ] **Step 5:** รันเทสต์ — คาดว่า PASS ทั้งหมด (รวมเทสต์เดิมของ `libs/common`) และ `pnpm --filter @internpath/common lint` ผ่าน
- [ ] **Step 6: Commit** (รอผู้ใช้สั่ง): `feat(common): add OutboxWriter and envelope builder`

---

### Task 2: Broker connection และ Topology (รวมการยืนยันกลไก retry กับ RabbitMQ จริง)

**Files:**
- Create: `libs/common/src/messaging/topology.ts`, `libs/common/src/messaging/broker-connection.ts`
- Test: `libs/common/test/messaging/topology.spec.ts` (unit), `libs/common/test/integration/helpers.ts`, `libs/common/test/integration/broker.spec.ts`

**Interfaces:**
- Consumes: ค่าคงที่/`routingKey` จาก `@internpath/contracts`
- Produces:
```ts
export const RETRY_RETURN_EXCHANGE = 'internpath.retry-return'; // headers exchange
export const DEFAULT_RETRY_DELAYS_MS: readonly number[] = [5000, 30000, 120000];
export const consumerQueueName = (consumer: string, type: string): string; // `${consumer}.${type}`
export const dlqName = (queue: string): string;                              // `${queue}.dlq`
export const retryQueueName = (service: string, attempt: number): string;    // `${service}.retry.${attempt}` (attempt เริ่ม 1)
export function assertBaseTopology(ch: Channel): Promise<void>;
export function assertConsumerTopology(ch: Channel, a: { service: string; producer: ServiceName; type: string; retryDelaysMs: readonly number[] }): Promise<{ queue: string; dlq: string }>;
export class BrokerConnection {
  constructor(opts: { url: string; reconnect?: { minMs: number; maxMs: number } }); // default 1000..30000
  connect(): Promise<void>;
  isConnected(): boolean;
  onConnected(cb: () => Promise<void>): void;   // เรียกทุกครั้งที่ต่อสำเร็จ รวมการต่อใหม่
  createChannel(): Promise<Channel>;
  publish(exchange: string, routingKey: string, body: Buffer, options: PublishOptions): Promise<void>; // resolve หลัง broker confirm; throw ถ้าไม่ได้เชื่อมต่อ
  close(): Promise<void>;                       // ปิดแล้วต้องไม่ต่อใหม่
}
```
(`Channel`/`PublishOptions` ใช้ชนิดจาก `amqplib` ที่ติดตั้งอยู่)

**กลไก retry ที่ต้องทำให้ถูกต้อง:** retry queue `<service>.retry.<n>` ตั้ง `x-message-ttl` = หน่วงครั้งที่ n และ `x-dead-letter-exchange = RETRY_RETURN_EXCHANGE` (ไม่ตั้ง dead-letter routing key); ผู้รับ publish ข้อความลง retry queue ผ่าน default exchange พร้อม header `x-origin-queue = <ชื่อคิวต้นทาง>`; คิวผู้รับทุกตัวผูกกับ `RETRY_RETURN_EXCHANGE` (headers exchange) ด้วย `{ 'x-match': 'all', 'x-origin-queue': <ชื่อคิวของตัวเอง> }` เพื่อรับข้อความกลับ; คิวผู้รับตั้ง `x-dead-letter-exchange = DLX_EXCHANGE` และ `x-dead-letter-routing-key = <ชื่อคิว>`, DLQ ผูกกับ DLX ด้วย key เดียวกัน (`nack(requeue=false)` จึงเข้า DLQ)

- [ ] **Step 1:** เขียนเทสต์ unit `topology.spec.ts`: `consumerQueueName('notification','JobVerified') === 'notification.JobVerified'`, `dlqName` ต่อท้าย `.dlq`, `retryQueueName('job',2) === 'job.retry.2'`, และ `DEFAULT_RETRY_DELAYS_MS` เท่ากับ `[5000,30000,120000]`
- [ ] **Step 2:** เขียน `integration/helpers.ts`: `brokerUrl()` (ค่าจาก `RABBITMQ_URL` ถ้าไม่มีใช้ `amqp://internpath:change-me@localhost:5672`), `pgUrl()` (ค่าจาก `MESSAGING_IT_DATABASE_URL` ถ้าไม่มีใช้ `postgresql://internpath:change-me@localhost:5432/internpath`), `reachableOrSkip(ctx)` (ต่อ timeout สั้น ถ้าไม่ได้เรียก `ctx.skip()`), `uniqueService()` (ชื่อสุ่มขึ้นต้น `it`), และตัวเก็บ/ลบ queue-exchange ที่สร้างระหว่างเทสต์
- [ ] **Step 3: เขียนเทสต์ integration ที่ล้มก่อน** `broker.spec.ts` (`this.timeout(20000)`):
  - `ข้อความใน retry queue กลับมาที่คิวต้นทางหลังหน่วง พร้อม body และ header เดิม` (ใช้ `retryDelaysMs [100, 200, 300]`, publish ลง `retryQueueName` ด้วย `origin-queue`, assert ได้ข้อความจากคิวต้นทางภายใน 3 วินาที และไม่โผล่ในคิวผู้รับอื่น)
  - `nack(requeue=false) จากคิวผู้รับเข้า DLQ ของคิวนั้น`
  - `ข้อความที่ publish ผ่าน events exchange ด้วย routingKey producer.Type ถึงคิวที่ผูกไว้`
  - `BrokerConnection ต่อใหม่เองและเรียก onConnected อีกครั้งหลังการเชื่อมต่อถูกตัด` (ปิด connection ภายในจากฝั่งเทสต์ แล้วรอ `isConnected()` กลับเป็น true ภายใน 5 วินาที); และ `publish ตอนไม่ได้เชื่อมต่อ throw (ไม่ค้าง)`; และ `close() แล้วไม่ต่อใหม่`
- [ ] **Step 4:** เปิด Docker (`pnpm infra:up` หรือ `docker compose --profile infra up -d postgres rabbitmq`) แล้วรัน `pnpm --filter @internpath/common test` — คาดว่า integration FAIL (ยังไม่มีโมดูล) และ unit FAIL
- [ ] **Step 5:** Implement ตาม Interfaces; `BrokerConnection` สร้าง confirm channel สำหรับ `publish` (สร้างใหม่หลังต่อใหม่); ต่อใหม่ด้วย backoff แบบทวีคูณระหว่าง `minMs..maxMs`; ผูก handler `error`/`close` ของ connection และ channel ไม่ให้เกิด unhandled error
- [ ] **Step 6:** รันเทสต์ — คาดว่า PASS; **ถ้ากลไกคืนข้อความผ่าน headers exchange ไม่ทำงานบน RabbitMQ จริง ให้แก้กลไกให้ผ่านเทสต์ แล้วจดสิ่งที่ต่างไว้เพื่อไปแก้ `event-contract.md` §3.3 ใน Task 7** ตรวจว่า `docker exec internpath-rabbitmq-1 rabbitmqctl list_queues name` ไม่มีคิว `it*` ค้างหลังเทสต์จบ
- [ ] **Step 7: Commit** (รอผู้ใช้สั่ง): `feat(common): add broker connection and retry/DLQ topology`

---

### Task 3: OutboxRelay

**Files:**
- Create: `libs/common/src/outbox/outbox-relay.ts`
- Test: `libs/common/test/outbox/outbox-relay.spec.ts`

**Interfaces:**
- Consumes: `buildEnvelope`, `OutboxRow` (Task 1); `BrokerConnection.publish` (Task 2)
- Produces:
```ts
export interface RelayDb { query(sql: string, params?: unknown[]): Promise<{ rows: any[] }> } // ใช้ pg.Client ได้
export interface EventPublisher { publish(exchange: string, routingKey: string, body: Buffer, options: PublishOptions): Promise<void> }
export interface OutboxRelayOptions { service: ServiceName; db: RelayDb; publisher: EventPublisher; batchSize?: number /*50*/; busyIntervalMs?: number /*2000*/; idleIntervalMs?: number /*10000*/ }
export function nextRelayDelayMs(published: number, o: { busyIntervalMs: number; idleIntervalMs: number }): number;
export class OutboxRelay { constructor(o: OutboxRelayOptions); runOnce(): Promise<number>; start(): void; stop(): Promise<void> }
```
`runOnce` ทำใน Transaction เดียว: `BEGIN` → `pg_try_advisory_xact_lock(hashtext('internpath.outbox_relay'))` (ได้ false → `ROLLBACK` คืน 0) → `SELECT` แถว `published_at IS NULL` เรียง `created_at, id` จำกัด `batchSize` → publish ทีละแถวตามลำดับ → `UPDATE … SET published_at = now(), attempts = attempts + 1` ต่อแถวที่สำเร็จ → ถ้า publish ล้ม: `UPDATE … SET attempts = attempts + 1` แถวนั้น, **หยุดทันทีไม่ส่งแถวถัดไป**, `COMMIT` ส่วนที่สำเร็จ แล้วคืนจำนวนที่ส่งได้

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (fake `db` บันทึกลำดับ SQL, fake `publisher` บันทึก args):
  - `publish ตามลำดับ created_at ด้วย exchange EVENTS_EXCHANGE, routingKey 'job.JobSubmitted', messageId=event_id, persistent, header x-correlation-id และ mark ทีละแถว`
  - `หยุดที่แถวแรกที่ publish ล้ม: แถวหลังไม่ถูกส่ง, แถวที่ล้มได้ attempts+1, แถวก่อนหน้าถูก mark และ COMMIT, คืนจำนวนที่ส่งสำเร็จ`
  - `ถ้าได้ advisory lock ไม่สำเร็จ (replica ตัวที่สอง): ไม่ SELECT ไม่ publish, ROLLBACK, คืน 0`
  - `nextRelayDelayMs: ส่งได้ >0 แถว → 2000, ไม่มีงาน → 10000`
  - `start() ทำงานต่อหลัง db.query reject (Postgres ล่ม): log แล้วลองรอบถัดไป ไม่ throw ออกนอก loop` (ใช้ interval สั้น เช่น 10 ms) และ `stop() รอรอบที่ค้างอยู่จบแล้วไม่เรียก db อีก`
  - `log ไม่มี payload ของ event` (spy logger: ข้อความไม่มี JSON ของ payload)
- [ ] **Step 2:** รันเทสต์ — คาดว่า FAIL
- [ ] **Step 3:** Implement ตาม Interfaces; ใช้ `Logger` จาก `@nestjs/common`; loop ใช้ `setTimeout` ต่อรอบ (ไม่ใช้ `setInterval`) เพื่อไม่ให้รอบซ้อนกัน
- [ ] **Step 4:** รันเทสต์ — คาดว่า PASS
- [ ] **Step 5: Commit** (รอผู้ใช้สั่ง): `feat(common): add OutboxRelay`

---

### Task 4: EventConsumer

**Files:**
- Create: `libs/common/src/messaging/event-consumer.ts`
- Test: `libs/common/test/messaging/event-consumer.spec.ts`

**Interfaces:**
- Consumes: `BrokerConnection`, `assertConsumerTopology`, `retryQueueName`, `DEFAULT_RETRY_DELAYS_MS` (Task 2)
- Produces:
```ts
export interface ProcessedEventsTx { processedEvent: { createMany(args: { data: { eventId: string; consumer: string }[]; skipDuplicates: true }): Promise<{ count: number }> } }
export interface Subscription<Tx, P = unknown> { producer: ServiceName; type: string; supportedVersions?: number[] /*[1]*/; handler(envelope: EventEnvelope<string, P>, tx: Tx): Promise<void> }
export interface DeadLetterInfo { queue: string; eventId?: string; type?: string; reason: 'retries_exhausted' | 'invalid_message' | 'unsupported_version' }
export interface EventConsumerOptions<Tx> { service: ServiceName; runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T>; retryDelaysMs?: readonly number[]; prefetch?: number /*10*/; onDeadLetter?(i: DeadLetterInfo): void }
export type DeliveryOutcome = { kind: 'ack' } | { kind: 'retry'; nextCount: number } | { kind: 'dead-letter'; reason: DeadLetterInfo['reason'] };
export function processDelivery<Tx extends ProcessedEventsTx>(a: { raw: Buffer; retryCount: number; queue: string; sub: Subscription<Tx>; runInTransaction: EventConsumerOptions<Tx>['runInTransaction']; maxRetries: number }): Promise<DeliveryOutcome>;
export class EventConsumer<Tx extends ProcessedEventsTx> { constructor(broker: BrokerConnection, o: EventConsumerOptions<Tx>); subscribe<P>(sub: Subscription<Tx, P>): Promise<void>; close(): Promise<void> }
```
กติกาของ `processDelivery`: parse JSON และตรวจ envelope (`event_id`, `type` ตรงกับ `sub.type`, `version`, `payload` มี) → ไม่ผ่าน = `dead-letter invalid_message` โดยไม่เรียก `runInTransaction`; `version` ไม่อยู่ใน `supportedVersions` = `dead-letter unsupported_version`; ใน `runInTransaction`: `processedEvent.createMany({ data: [{ eventId, consumer: queue }], skipDuplicates: true })` ได้ `count 0` = ซ้ำ → `ack` ไม่เรียก handler; ไม่ซ้ำ → เรียก `handler(envelope, tx)`; handler throw → ผลลัพธ์ `retry` (`nextCount = retryCount + 1`) ถ้า `retryCount < maxRetries` ไม่เช่นนั้น `dead-letter retries_exhausted`; ฟิลด์ที่ไม่รู้จักใน envelope/payload ต้องไม่ทำให้ล้ม

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** สำหรับ `processDelivery` (fake `runInTransaction` ที่ rollback เมื่อ fn throw โดยเก็บ marker ใน Set ที่ commit เมื่อสำเร็จเท่านั้น):
  - `ครั้งแรก: เรียก handler หนึ่งครั้งด้วย envelope และ tx เดียวกัน, บันทึก marker consumer = ชื่อคิว, ผล ack`
  - `ได้ event_id เดิมซ้ำ: handler ไม่ถูกเรียก, ผล ack`
  - `handler throw ที่ retryCount 0: ผล retry nextCount 1 และ marker ไม่ถูกบันทึก (rollback) จึงลองใหม่ได้`
  - `handler throw ที่ retryCount 3 (maxRetries 3): dead-letter retries_exhausted`
  - `JSON พัง / ไม่มี event_id / type ไม่ตรง: dead-letter invalid_message และ runInTransaction ไม่ถูกเรียก`
  - `version 2 เมื่อ supportedVersions [1]: dead-letter unsupported_version`
  - `envelope มีฟิลด์เพิ่มที่ไม่รู้จัก: ประมวลผลปกติ`

  และสำหรับ `EventConsumer` (fake `BrokerConnection`/channel บันทึกลำดับการเรียก):
  - `ack ถูกเรียกหลัง runInTransaction resolve เท่านั้น (ลำดับ: transaction → ack)`
  - `outcome retry: publish ไป <service>.retry.<nextCount> พร้อม x-retry-count และ x-origin-queue แล้วจึง ack ต้นฉบับ (ถ้า publish ล้ม ไม่ ack → ข้อความไม่หาย)`
  - `outcome dead-letter: nack(requeue=false) และเรียก onDeadLetter โดย info ไม่มี payload`
- [ ] **Step 2:** รันเทสต์ — คาดว่า FAIL
- [ ] **Step 3:** Implement; `queue = consumerQueueName(options.service, sub.type)`; อ่าน `x-retry-count` จาก header (ไม่มี = 0); `subscribe` เรียก `assertConsumerTopology` และ `consume` ใน `onConnected` เพื่อ subscribe ใหม่หลังต่อใหม่; `prefetch` ตั้งที่ channel; `onDeadLetter` ไม่ถูกตั้ง = log ระดับ `error` ด้วย `DeadLetterInfo` เท่านั้น
- [ ] **Step 4:** รันเทสต์ — คาดว่า PASS
- [ ] **Step 5: Commit** (รอผู้ใช้สั่ง): `feat(common): add EventConsumer with idempotency, retry and DLQ`

---

### Task 5: MessagingModule

**Files:**
- Create: `libs/common/src/messaging/messaging.module.ts`
- Modify: `libs/common/src/index.ts` (export `outbox/*` และ `messaging/*` ทั้งหมด)
- Test: `libs/common/test/messaging/messaging.module.spec.ts`

**Interfaces:**
- Consumes: `BrokerConnection`, `OutboxWriter`, `OutboxRelay`, `EventConsumer`
- Produces:
```ts
export interface MessagingModuleOptions<Tx extends ProcessedEventsTx = ProcessedEventsTx> {
  service: ServiceName;
  publishes?: { databaseUrlEnv: string };                         // เปิด relay; อ่าน DB URL จาก ConfigService ด้วยชื่อตัวแปรนี้
  consumes?: Omit<EventConsumerOptions<Tx>, 'service'>;          // เปิด EventConsumer
}
export class MessagingModule { static register<Tx extends ProcessedEventsTx>(o: MessagingModuleOptions<Tx>): DynamicModule } // global; export OutboxWriter, BrokerConnection, EventConsumer (เมื่อ consumes)
```

- [ ] **Step 1: เขียนเทสต์ที่ล้มก่อน** (Nest `Test.createTestingModule` + override `BrokerConnection` ด้วย fake):
  - `register({ service, publishes }) เริ่ม relay ตอน module init และ stop ตอน shutdown (relay.stop ถูกเรียก, connection ปิด)`
  - `ไม่ใส่ publishes: ไม่มี relay ถูกสร้าง/เริ่ม`
  - `ใส่ consumes: inject EventConsumer ได้ และ subscribe ใช้งานได้; ไม่ใส่: ไม่มี provider`
  - `ไม่มี RABBITMQ_URL: module init ล้มพร้อมข้อความที่ระบุชื่อตัวแปร`
- [ ] **Step 2:** รันเทสต์ — คาดว่า FAIL
- [ ] **Step 3:** Implement; relay ใช้ `pg.Client` เดียวที่เปิดตลอดอายุ module (ต่อใหม่เมื่อหลุดโดยให้ error ของ relay จัดการผ่าน loop ใน Task 3); ปิดทุกอย่างใน `onApplicationShutdown`; ตรวจว่า `pnpm --filter @internpath/common build` ผ่านและ `apps/job` ยัง build ได้ (`pnpm --filter @internpath/job build`)
- [ ] **Step 4:** รันเทสต์ — คาดว่า PASS
- [ ] **Step 5: Commit** (รอผู้ใช้สั่ง): `feat(common): add MessagingModule`

---

### Task 6: Integration แบบ end-to-end (RabbitMQ + Postgres จริง)

**Files:**
- Test: `libs/common/test/integration/messaging.e2e.spec.ts` (ใช้ `helpers.ts` จาก Task 2; เพิ่ม helper สร้าง schema ชั่วคราว `msg_it_<random>` พร้อมตาราง `outbox_events` และ `processed_events` ตาม data-schema §2.2 แล้ว `DROP SCHEMA … CASCADE` ตอนจบ)

**Interfaces:**
- Consumes: ทั้งหมดจาก Task 1-5; fake tx ที่เขียนเองบน `pg` (`outboxEvent.create` → INSERT, `processedEvent.createMany` → `INSERT … ON CONFLICT DO NOTHING` คืน `count`, `runInTransaction` → BEGIN/COMMIT/ROLLBACK บน client เดียว)

- [ ] **Step 1: เขียนเทสต์** (`this.timeout(30000)`; ข้ามเมื่อไม่มี Docker; ใช้ `retryDelaysMs [100, 200, 300]` และ `idle/busy` ของ relay สั้น):
  - `Event ที่ add ใน Transaction ถึง handler ผ่าน relay และ outbox ถูก mark published`
  - `Transaction ของผู้ส่งที่ ROLLBACK ไม่ทำให้ Event ถูกส่ง (ไม่มีแถว outbox, ไม่มีข้อความถึงผู้รับ)`
  - `ส่ง Event เดียวกันซ้ำ (publish ซ้ำด้วย event_id เดิม): handler ทำงานครั้งเดียว`
  - `handler throw สองครั้งแล้วสำเร็จ: ถูกเรียกครบ 3 ครั้ง มี marker หนึ่งแถว และ ack`
  - `handler throw ตลอด: เรียก 1 + 3 ครั้ง แล้วข้อความอยู่ใน DLQ และ onDeadLetter ถูกเรียกหนึ่งครั้ง`
  - `Message เสีย (publish JSON พัง ตรงๆ ลงคิว): เข้า DLQ ทันที และ consumer ยังรับข้อความถัดไปได้`
  - `relay สองตัวชี้ฐานเดียวกันพร้อมกัน: ผู้รับได้แต่ละ Event ครั้งเดียว ตามลำดับ created_at`
- [ ] **Step 2:** รันเทสต์ — ถ้าล้มเพราะบั๊กใน Task 1-5 ให้แก้ที่ต้นเหตุ (ไม่ใช่ปรับเทสต์ให้ผ่าน); ผลสุดท้าย: ทุกเทสต์ PASS และ `rabbitmqctl list_queues`/`psql \dn` ไม่มีของ `it*`/`msg_it_*` ค้าง
- [ ] **Step 3:** ยืนยันว่าเมื่อปิด Docker แล้วรัน `pnpm --filter @internpath/common test` ชุด integration ถูกข้าม (pending) และชุดอื่นผ่าน
- [ ] **Step 4: Commit** (รอผู้ใช้สั่ง): `test(common): add messaging end-to-end integration tests`

---

### Task 7: เอกสาร, compose และการตรวจกับ CloudAMQP

**Files:**
- Modify: `docs/developer-guide.md` (§6.3 ข้อ 3-4, §7), `docs/architecture.md` (§3 บรรทัด `libs/common`), `docs/event-contract.md` (§3.3 ตามที่ Task 2 พบ), `docker-compose.yml` (พอร์ตและ restart)

- [ ] **Step 1:** `developer-guide.md` §6.3 ข้อ 3: เปลี่ยนเป็นตัวอย่างเรียก `outbox.add(tx, {...})` ใน `$transaction` และข้อ 4: ตัวอย่าง `consumer.subscribe({ producer, type, handler })` พร้อมส่ง `runInTransaction`; §7: ติ๊กรายการ "Outbox relay และ Consumer" และรายการ "Retry queue ร่วมต่อ Service เพื่ออยู่ในเพดาน queue ของ CloudAMQP" ที่ทำแล้ว (3 คิวต่อ Service)
- [ ] **Step 2:** `architecture.md` §3: `libs/common` จาก "Outbox publisher" เป็น "Outbox relay, Event consumer (idempotency + retry/DLQ)"; `event-contract.md` §3.3: ระบุกลไกคืนข้อความจริง (headers exchange `internpath.retry-return` + header `origin-queue`) ตามที่ผ่านเทสต์ใน Task 2
- [ ] **Step 3:** `docker-compose.yml`: พอร์ตของ postgres, rabbitmq (5672, 15672) และ minio (9000, 9001) เปลี่ยนเป็น `"127.0.0.1:<host>:<container>"`; เพิ่ม `restart: unless-stopped` ให้ postgres, rabbitmq, minio; ติ๊กรายการนั้นใน `developer-guide.md` §7
- [ ] **Step 4: ตรวจ:** `docker compose --profile infra config` ผ่าน; `docker compose --profile infra up -d postgres rabbitmq mailpit` สร้าง container ใหม่; `docker compose ps` แสดงพอร์ตขึ้นต้น `127.0.0.1:`; รัน `pnpm --filter @internpath/common test` ผ่านทั้งหมดกับ container ใหม่; `pnpm lint && pnpm build` ที่รากผ่าน
- [ ] **Step 5 (ผู้ใช้เป็นคนทำ):** ตรวจกับ CloudAMQP หนึ่งครั้ง — ตั้ง `RABBITMQ_URL` เป็นของ CloudAMQP **ในเชลล์ของผู้ใช้เอง** (ห้ามวางค่าใน repo/แชต) แล้วรัน `pnpm --filter @internpath/common test` จดผลของ: การต่อ TLS, จำนวน queue ที่เทสต์ใช้ต่อ Service เทียบเพดานแผนฟรี, และยืนยันว่าเทสต์ลบ queue ทิ้งครบ ถ้าชนเพดานให้ลดจำนวนคิวของเทสต์ แล้วบันทึกผลใน `docs/architecture.md` §8.1 บรรทัด CloudAMQP
- [ ] **Step 6: Commit** (รอผู้ใช้สั่ง): `docs,chore: document messaging usage; bind infra ports to localhost`

---

## Self-Review

- **ครอบคลุม spec:** §5.1 → Task 1; §5.2 → Task 3; §5.3 → Task 4; §5.4 → Task 2 (+ Task 4 ใช้งาน); §5.5 → Task 5; §5.6 → Task 3/4 (unit) และ Task 2/6 (integration, ข้ามได้); §6 เอกสารและ compose → Task 7; §7 (กลไกคืนข้อความ) → Task 2 Step 6 → Task 7 Step 2
- **ส่วนเบี่ยงจาก spec:** spec §5.5 ให้ "เปิดสถานะ connection ให้ `/ready`" — เปลี่ยนเป็นมีแค่ `BrokerConnection.isConnected()` เพราะ `HealthModule` เดิมตรวจ broker เองอยู่แล้ว (ไม่เพิ่มของที่ไม่จำเป็น) และ spec §8 ระบุ idle interval ไม่ชัด → ใช้ 10 วินาที
- **ความสอดคล้องของชนิด:** `ProcessedEventsTx`, `Subscription`, `EventConsumerOptions`, `BrokerConnection.publish` ใช้ชื่อเดียวกันใน Task 2-5; `EventPublisher` (Task 3) เข้ากับ `BrokerConnection.publish` โดยโครงสร้าง
- **ความเสี่ยงที่ยังเปิด:** ชนิดของ Prisma `tx` กับ `OutboxTx`/`ProcessedEventsTx` ยังไม่ได้เทียบกับ Prisma client จริง (ไม่มี client ถูก generate ในตอนนี้) — เมื่อ Service แรกนำไปใช้ถ้า TypeScript ไม่ยอมรับ ให้ปรับ interface ให้หลวมลง (เช่น generic บน payload) ไม่ใช่ import Prisma เข้า lib
