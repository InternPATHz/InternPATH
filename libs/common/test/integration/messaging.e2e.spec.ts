import { randomBytes, randomUUID } from 'node:crypto';
import { EVENTS_EXCHANGE, type EventEnvelope, type ServiceName } from '@internpath/contracts';
import { expect } from 'chai';
import { Client, Pool, type PoolClient } from 'pg';
import {
  BrokerConnection,
  EventConsumer,
  OutboxRelay,
  OutboxWriter,
  PgRelayDb,
  consumerQueueName,
  dlqName,
  retryQueueName,
  type DeadLetterInfo,
  type EventPublisher,
  type OutboxTx,
  type ProcessedEventsTx,
} from '../../src';
import {
  QueueCleanup,
  brokerReachableOrSkip,
  brokerUrl,
  getWithin,
  pgReachableOrSkip,
  pgUrl,
  uniqueService,
  waitFor,
} from './helpers';

type ItTx = ProcessedEventsTx & OutboxTx;

const hex = () => randomBytes(4).toString('hex');
const RETRY_DELAYS = [100, 200, 300];

/** fake Prisma tx เหนือ pg: เข้ากับ OutboxTx / ProcessedEventsTx เชิงโครงสร้าง */
function makeTx(client: PoolClient): ItTx {
  return {
    outboxEvent: {
      create: async ({ data }) =>
        client.query(
          `INSERT INTO outbox_events (id, type, version, aggregate_id, payload, correlation_id, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            data.id,
            data.type,
            data.version,
            data.aggregateId,
            JSON.stringify(data.payload),
            data.correlationId,
            data.createdAt,
          ],
        ),
    },
    processedEvent: {
      createMany: async ({ data }) => {
        let count = 0;
        for (const d of data) {
          const r = await client.query(
            'INSERT INTO processed_events (event_id, consumer) VALUES ($1, $2) ON CONFLICT DO NOTHING',
            [d.eventId, d.consumer],
          );
          count += r.rowCount ?? 0;
        }
        return { count };
      },
    },
  };
}

describe('integration: messaging end-to-end (RabbitMQ + Postgres จริง)', function () {
  this.timeout(30000);

  const schema = `msg_it_${hex()}`;
  let admin: Pool; // ตารางอยู่ใน schema ชั่วคราวของเทสต์นี้
  const cleanup = new QueueCleanup();
  const brokers: BrokerConnection[] = [];
  const consumers: Array<EventConsumer<ItTx>> = [];
  const relays: OutboxRelay[] = [];
  const relayDbs: PgRelayDb[] = [];
  const writer = new OutboxWriter();

  before(async function () {
    await brokerReachableOrSkip(this);
    await pgReachableOrSkip(this);
    admin = new Pool({ connectionString: pgUrl(), options: `-c search_path=${schema}`, max: 8 });
    const boot = new Client({ connectionString: pgUrl() });
    await boot.connect();
    try {
      await boot.query(`CREATE SCHEMA ${schema}`);
      await boot.query(`
        CREATE TABLE ${schema}.outbox_events (
          id uuid PRIMARY KEY, type text NOT NULL, version int NOT NULL DEFAULT 1,
          aggregate_id uuid NOT NULL, payload jsonb NOT NULL, correlation_id uuid NOT NULL,
          created_at timestamptz NOT NULL DEFAULT now(), published_at timestamptz,
          attempts int NOT NULL DEFAULT 0
        );
        CREATE TABLE ${schema}.processed_events (
          event_id uuid NOT NULL, consumer text NOT NULL,
          processed_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (event_id, consumer)
        );`);
    } finally {
      await boot.end();
    }
  });

  after(async function () {
    if (!admin) return; // ถูกข้าม
    await admin.end().catch(() => undefined);
    const c = new Client({ connectionString: pgUrl() });
    await c.connect();
    await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await c.end();
  });

  beforeEach(async () => {
    await admin.query('TRUNCATE outbox_events, processed_events');
  });

  afterEach(async () => {
    await Promise.all(relays.splice(0).map((r) => r.stop()));
    await Promise.all(relayDbs.splice(0).map((d) => d.close()));
    await Promise.all(consumers.splice(0).map((c) => c.close()));
    await Promise.all(brokers.splice(0).map((b) => b.close().catch(() => undefined)));
    await cleanup.run();
  });

  async function runInTransaction<T>(fn: (tx: ItTx) => Promise<T>): Promise<T> {
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const r = await fn(makeTx(client));
      await client.query('COMMIT');
      return r;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  async function newBroker(): Promise<BrokerConnection> {
    const b = new BrokerConnection({ url: brokerUrl() });
    brokers.push(b);
    await b.connect();
    return b;
  }

  /** ตั้ง consumer หนึ่งตัวต่อ EventType (รวมลงทะเบียนคิวที่ต้องลบตอนจบ) */
  async function setupConsumer(
    type: string,
    handler: (env: EventEnvelope, tx: ItTx) => Promise<void>,
    onDeadLetter?: (i: DeadLetterInfo) => void,
  ) {
    const service = uniqueService() as ServiceName;
    const broker = await newBroker();
    const queue = consumerQueueName(service, type);
    cleanup.add(queue, dlqName(queue), ...RETRY_DELAYS.map((_, i) => retryQueueName(service, i + 1)));
    const consumer = new EventConsumer<ItTx>(broker, {
      service,
      runInTransaction,
      retryDelaysMs: RETRY_DELAYS,
      onDeadLetter,
    });
    consumers.push(consumer);
    await consumer.subscribe({ producer: 'job', type, handler });
    return { service, broker, queue, dlq: dlqName(queue) };
  }

  async function startRelay(publisher: EventPublisher): Promise<OutboxRelay> {
    const db = new PgRelayDb(
      pgUrl(),
      (url) => new Client({ connectionString: url, options: `-c search_path=${schema}` }) as never,
    );
    relayDbs.push(db);
    const relay = new OutboxRelay({ service: 'job', db, publisher, busyIntervalMs: 20, idleIntervalMs: 20 });
    relays.push(relay);
    relay.start();
    return relay;
  }

  const count = async (table: string): Promise<number> =>
    Number((await admin.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n);

  const envelopeFor = (type: string, payload: unknown = { n: 1 }): EventEnvelope => ({
    event_id: randomUUID(),
    type,
    version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    producer: 'job',
    payload,
  });

  it('Event ที่ add ใน Transaction ถึง handler ผ่าน relay และ outbox ถูก mark published', async () => {
    const type = `It${hex()}`;
    const got: EventEnvelope[] = [];
    const { broker } = await setupConsumer(type, async (env) => void got.push(env));
    await startRelay(broker);

    const payload = { job_id: 'j1', nested: { k: [1, 2] } };
    const aggregateId = randomUUID();
    const id = await runInTransaction((tx) =>
      writer.add(tx, { type, aggregateId, correlationId: randomUUID(), payload }),
    );

    await waitFor(() => got.length === 1, 'handler received event');
    expect(got[0].event_id).to.equal(id);
    expect(got[0].payload).to.deep.equal(payload);
    expect(got[0].producer).to.equal('job');
    await waitFor(
      async () => (await admin.query('SELECT 1 FROM outbox_events WHERE id = $1 AND published_at IS NOT NULL', [id])).rowCount === 1,
      'outbox row marked published',
    );
  });

  it('Transaction ของผู้ส่งที่ ROLLBACK ไม่ทำให้ Event ถูกส่ง (ไม่มีแถว outbox, ไม่มีข้อความถึงผู้รับ)', async () => {
    const type = `It${hex()}`;
    const got: EventEnvelope[] = [];
    const { broker } = await setupConsumer(type, async (env) => void got.push(env));
    await startRelay(broker);

    let err: Error | undefined;
    try {
      await runInTransaction(async (tx) => {
        await writer.add(tx, { type, aggregateId: randomUUID(), correlationId: randomUUID(), payload: {} });
        throw new Error('business failure');
      });
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal('business failure');
    await new Promise((r) => setTimeout(r, 400));
    expect(await count('outbox_events')).to.equal(0);
    expect(got).to.have.length(0);
  });

  it('ส่ง Event เดียวกันซ้ำ (publish ซ้ำด้วย event_id เดิม): handler ทำงานครั้งเดียว', async () => {
    const type = `It${hex()}`;
    const handled: string[] = [];
    const { broker } = await setupConsumer(type, async (env) => void handled.push(env.event_id));

    const dup = envelopeFor(type);
    const sentinel = envelopeFor(type);
    for (const e of [dup, dup, sentinel]) {
      await broker.publish(EVENTS_EXCHANGE, `job.${type}`, Buffer.from(JSON.stringify(e)), {
        messageId: e.event_id,
      });
    }
    // คิว FIFO: เมื่อ sentinel ถูกประมวลผลแล้ว dup ทั้งสองถูกพิจารณาไปแล้ว
    await waitFor(() => handled.includes(sentinel.event_id), 'sentinel handled');
    expect(handled.filter((id) => id === dup.event_id)).to.have.length(1);
    expect(await count('processed_events')).to.equal(2);
  });

  it('handler throw สองครั้งแล้วสำเร็จ: ถูกเรียกครบ 3 ครั้ง มี marker หนึ่งแถว และ ack', async () => {
    const type = `It${hex()}`;
    let calls = 0;
    const dead: DeadLetterInfo[] = [];
    const { broker, queue } = await setupConsumer(
      type,
      async () => {
        calls++;
        if (calls < 3) throw new Error('transient');
      },
      (i) => dead.push(i),
    );
    const e = envelopeFor(type);
    await broker.publish(EVENTS_EXCHANGE, `job.${type}`, Buffer.from(JSON.stringify(e)), { messageId: e.event_id });

    await waitFor(() => calls === 3, 'handler called 3 times');
    await waitFor(async () => (await broker.createChannel().then(async (ch) => {
      const q = await ch.checkQueue(queue);
      await ch.close();
      return q.messageCount;
    })) === 0, 'queue drained (acked)');
    expect(await count('processed_events')).to.equal(1);
    expect(dead).to.have.length(0);
  });

  it('handler throw ตลอด: เรียก 1 + 3 ครั้ง แล้วข้อความอยู่ใน DLQ และ onDeadLetter ถูกเรียกหนึ่งครั้ง', async () => {
    const type = `It${hex()}`;
    let calls = 0;
    const dead: DeadLetterInfo[] = [];
    const { broker, dlq } = await setupConsumer(
      type,
      async () => {
        calls++;
        throw new Error('permanent');
      },
      (i) => dead.push(i),
    );
    const e = envelopeFor(type);
    await broker.publish(EVENTS_EXCHANGE, `job.${type}`, Buffer.from(JSON.stringify(e)), { messageId: e.event_id });

    await waitFor(() => dead.length === 1, 'dead-letter callback');
    expect(calls).to.equal(4);
    expect(dead[0]).to.include({ reason: 'retries_exhausted', eventId: e.event_id });
    const ch = await broker.createChannel();
    const msg = await getWithin(ch, dlq, 3000);
    expect(msg, 'ข้อความอยู่ใน DLQ').to.not.equal(null);
    expect(JSON.parse(msg!.content.toString()).event_id).to.equal(e.event_id);
    expect(await count('processed_events')).to.equal(0);
  });

  it('Message เสีย (publish JSON พัง ตรงๆ ลงคิว): เข้า DLQ ทันที และ consumer ยังรับข้อความถัดไปได้', async () => {
    const type = `It${hex()}`;
    const handled: string[] = [];
    const dead: DeadLetterInfo[] = [];
    const { broker, dlq } = await setupConsumer(
      type,
      async (env) => void handled.push(env.event_id),
      (i) => dead.push(i),
    );
    await broker.publish(EVENTS_EXCHANGE, `job.${type}`, Buffer.from('{not json'), {});
    const good = envelopeFor(type);
    await broker.publish(EVENTS_EXCHANGE, `job.${type}`, Buffer.from(JSON.stringify(good)), {
      messageId: good.event_id,
    });

    await waitFor(() => handled.includes(good.event_id), 'next message still handled');
    expect(dead).to.have.length(1);
    expect(dead[0].reason).to.equal('invalid_message');
    const ch = await broker.createChannel();
    const msg = await getWithin(ch, dlq, 3000);
    expect(msg?.content.toString()).to.equal('{not json');
  });

  it('relay สองตัวชี้ฐานเดียวกันพร้อมกัน: ผู้รับได้แต่ละ Event ครั้งเดียว ตามลำดับ created_at', async () => {
    const type = `It${hex()}`;
    const handled: string[] = [];
    const { broker } = await setupConsumer(type, async (env) => void handled.push(env.event_id));

    const published: string[] = [];
    const counting: EventPublisher = {
      publish: async (exchange, key, body, options) => {
        published.push(String(options.messageId));
        await broker.publish(exchange, key, body, options);
      },
    };

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) {
      ids.push(
        await runInTransaction((tx) =>
          writer.add(tx, { type, aggregateId: randomUUID(), correlationId: randomUUID(), payload: { i } }),
        ),
      );
      await new Promise((r) => setTimeout(r, 5)); // ให้ created_at ต่างกันชัดเจน
    }

    await startRelay(counting);
    await startRelay(counting);

    await waitFor(() => handled.length === ids.length, 'all events handled');
    await new Promise((r) => setTimeout(r, 300)); // เผื่อ publish ซ้ำที่อาจตามมา
    expect(published, 'แต่ละ event publish ครั้งเดียว ตามลำดับ').to.deep.equal(ids);
    expect(handled).to.deep.equal(ids);
  });
});
