import { randomBytes, randomUUID } from 'node:crypto';
import { EVENTS_EXCHANGE, type ServiceName } from '@internpath/contracts';
import { expect } from 'chai';
import {
  BrokerConnection,
  EventConsumer,
  consumerQueueName,
  dlqName,
  retryQueueName,
  type ProcessedEventsTx,
} from '../../src';
import { QueueCleanup, brokerReachableOrSkip, brokerUrl, uniqueService, waitFor } from './helpers';

const hex = () => randomBytes(4).toString('hex');

describe('integration: resilience (RabbitMQ จริง, ผลรีวิว)', function () {
  this.timeout(30000);
  const cleanup = new QueueCleanup();
  const brokers: BrokerConnection[] = [];
  const consumers: Array<EventConsumer<ProcessedEventsTx>> = [];

  before(async function () {
    await brokerReachableOrSkip(this);
  });
  afterEach(async () => {
    await Promise.all(consumers.splice(0).map((c) => c.close()));
    await Promise.all(brokers.splice(0).map((b) => b.close().catch(() => undefined)));
    await cleanup.run();
  });

  const newBroker = async (): Promise<BrokerConnection> => {
    const b = new BrokerConnection({ url: brokerUrl(), reconnect: { minMs: 50, maxMs: 200 } });
    brokers.push(b);
    await b.connect();
    return b;
  };

  it('confirm channel ถูก broker ปิด (publish ไป exchange ที่ไม่มี): publish ถัดไปไป events exchange สำเร็จ ไม่ค้างตลอดไป', async () => {
    const broker = await newBroker();
    let err: Error | undefined;
    try {
      await broker.publish(`no.such.exchange.${hex()}`, 'k', Buffer.from('x'), {});
    } catch (e) {
      err = e as Error;
    }
    expect(err, 'publish ไป exchange ที่ไม่มีต้อง reject').to.be.instanceOf(Error);

    await waitFor(
      async () => {
        try {
          await broker.publish(EVENTS_EXCHANGE, 'job.NobodyListens', Buffer.from('x'), {});
          return true;
        } catch {
          return false;
        }
      },
      'publish works again after channel-level close',
      5000,
    );
    expect(broker.isConnected()).to.equal(true);
  });

  it('close() ระหว่างที่ connect ยังไม่เสร็จ: ไม่ทิ้ง connection ค้าง', async () => {
    const broker = new BrokerConnection({ url: brokerUrl() });
    brokers.push(broker);
    const connecting = broker.connect();
    await broker.close();
    await connecting.catch(() => undefined);
    await new Promise((r) => setTimeout(r, 300));
    expect(broker.isConnected()).to.equal(false);
  });

  it('consumer ยังรับ Event หลัง connection หลุดแล้วต่อใหม่ (ข้อความที่ publish ระหว่างหลุดไม่หาย)', async () => {
    const type = `It${hex()}`;
    const service = uniqueService() as ServiceName;
    const queue = consumerQueueName(service, type);
    cleanup.add(queue, dlqName(queue), ...[1, 2, 3].map((n) => retryQueueName(service, n)));

    const handled: string[] = [];
    const consumerBroker = await newBroker();
    const consumer = new EventConsumer<ProcessedEventsTx>(consumerBroker, {
      service,
      runInTransaction: async (fn) => fn({ processedEvent: { createMany: async () => ({ count: 1 }) } }),
      retryDelaysMs: [100, 200, 300],
      resubscribeDelayMs: 50,
    });
    consumers.push(consumer);
    await consumer.subscribe({ producer: 'job', type, handler: async (env) => void handled.push(env.event_id) });

    const producer = await newBroker();
    const send = async () => {
      const e = {
        event_id: randomUUID(),
        type,
        version: 1,
        occurred_at: new Date().toISOString(),
        correlation_id: randomUUID(),
        producer: 'job',
        payload: {},
      };
      await producer.publish(EVENTS_EXCHANGE, `job.${type}`, Buffer.from(JSON.stringify(e)), { messageId: e.event_id });
      return e.event_id;
    };

    const first = await send();
    await waitFor(() => handled.includes(first), 'first event handled');

    await (consumerBroker as unknown as { conn: { close(): Promise<void> } }).conn.close(); // ตัด connection ของ consumer
    const second = await send(); // publish ระหว่างที่ consumer หลุด/กำลังต่อใหม่
    await waitFor(() => handled.includes(second), 'event handled after reconnect', 15000);
    expect(handled.filter((id) => id === second)).to.have.length(1);
  });
});
