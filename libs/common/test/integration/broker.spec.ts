import { DLX_EXCHANGE, EVENTS_EXCHANGE, routingKey } from '@internpath/contracts';
import { expect } from 'chai';
import {
  BrokerConnection,
  ORIGIN_QUEUE_HEADER,
  assertBaseTopology,
  assertConsumerTopology,
  consumerQueueName,
  dlqName,
  retryQueueName,
} from '../../src';
import {
  QueueCleanup,
  brokerReachableOrSkip,
  brokerUrl,
  getWithin,
  uniqueService,
} from './helpers';

describe('integration: broker + topology (RabbitMQ จริง)', function () {
  this.timeout(20000);
  const cleanup = new QueueCleanup();
  const open: BrokerConnection[] = [];

  before(async function () {
    await brokerReachableOrSkip(this);
  });
  afterEach(async () => {
    await Promise.all(open.splice(0).map((b) => b.close().catch(() => undefined)));
    await cleanup.run();
  });

  async function setup(type: string, retryDelaysMs: number[] = [100, 200, 300]) {
    const service = uniqueService();
    const broker = new BrokerConnection({ url: brokerUrl() });
    open.push(broker);
    await broker.connect();
    const ch = await broker.createChannel();
    await assertBaseTopology(ch);
    const t = await assertConsumerTopology(ch, { service, producer: 'job', type, retryDelaysMs });
    cleanup.add(t.queue, t.dlq, ...retryDelaysMs.map((_, i) => retryQueueName(service, i + 1)));
    return { service, broker, ch, ...t };
  }

  it('ข้อความใน retry queue กลับมาที่คิวต้นทางหลังหน่วง พร้อม body และ header เดิม', async () => {
    const { service, broker, ch, queue } = await setup('JobSubmitted');
    const other = await assertConsumerTopology(ch, {
      service,
      producer: 'job',
      type: 'Other',
      retryDelaysMs: [100, 200, 300],
    });
    cleanup.add(other.queue, other.dlq);

    await broker.publish('', retryQueueName(service, 1), Buffer.from('hello'), {
      headers: { [ORIGIN_QUEUE_HEADER]: queue, 'x-retry-count': 1 },
    });
    const early = await ch.get(queue);
    expect(early, 'ต้องยังไม่กลับมาก่อนหน่วงครบ').to.equal(false);

    const msg = await getWithin(ch, queue, 3000);
    expect(msg, 'ต้องกลับมาที่คิวต้นทางภายใน 3 วินาที').to.not.equal(null);
    expect(msg!.content.toString()).to.equal('hello');
    expect(msg!.properties.headers![ORIGIN_QUEUE_HEADER]).to.equal(queue);
    expect(msg!.properties.headers!['x-retry-count']).to.equal(1);
    ch.ack(msg!);
    expect(await ch.get(other.queue), 'ต้องไม่โผล่ในคิวของ Consumer อื่น').to.equal(false);
  });

  it('ข้อความที่ publish ผ่าน events exchange ด้วย routingKey producer.Type ถึงคิวที่ผูกไว้', async () => {
    const { broker, ch, queue } = await setup('TypeC');
    await broker.publish(EVENTS_EXCHANGE, routingKey('job', 'TypeC'), Buffer.from('c'), {});
    const msg = await getWithin(ch, queue, 3000);
    expect(msg?.content.toString()).to.equal('c');
    ch.ack(msg!);
  });

  it('nack(requeue=false) จากคิวผู้รับเข้า DLQ ของคิวนั้น', async () => {
    const { service, broker, ch, queue, dlq } = await setup('TypeB');
    expect(queue).to.equal(consumerQueueName(service, 'TypeB'));
    expect(dlq).to.equal(dlqName(queue));
    await broker.publish(EVENTS_EXCHANGE, routingKey('job', 'TypeB'), Buffer.from('b'), {});
    const msg = await getWithin(ch, queue, 3000);
    ch.nack(msg!, false, false);
    const dead = await getWithin(ch, dlq, 3000);
    expect(dead?.content.toString()).to.equal('b');
    ch.ack(dead!);
    expect(DLX_EXCHANGE).to.equal('internpath.dlx');
  });

  it('BrokerConnection ต่อใหม่เองและเรียก onConnected อีกครั้งหลังการเชื่อมต่อถูกตัด', async () => {
    const broker = new BrokerConnection({ url: brokerUrl(), reconnect: { minMs: 50, maxMs: 200 } });
    open.push(broker);
    let connected = 0;
    broker.onConnected(async () => {
      connected++;
    });
    await broker.connect();
    expect(connected).to.equal(1);
    await (broker as unknown as { conn: { close(): Promise<void> } }).conn.close();
    const end = Date.now() + 5000;
    while (Date.now() < end && !(connected === 2 && broker.isConnected())) {
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(connected).to.equal(2);
    expect(broker.isConnected()).to.equal(true);
    await broker.publish(EVENTS_EXCHANGE, 'job.NobodyListens', Buffer.from('x'), {});
  });

  it('publish ตอนไม่ได้เชื่อมต่อ throw (ไม่ค้าง)', async () => {
    const broker = new BrokerConnection({ url: brokerUrl() });
    let err: Error | undefined;
    try {
      await broker.publish(EVENTS_EXCHANGE, 'job.X', Buffer.from('x'), {});
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.match(/not connected/i);
  });

  it('close() แล้วไม่ต่อใหม่', async () => {
    const broker = new BrokerConnection({ url: brokerUrl(), reconnect: { minMs: 20, maxMs: 50 } });
    let connected = 0;
    broker.onConnected(async () => {
      connected++;
    });
    await broker.connect();
    await broker.close();
    await new Promise((r) => setTimeout(r, 400));
    expect(connected).to.equal(1);
    expect(broker.isConnected()).to.equal(false);
  });
});
