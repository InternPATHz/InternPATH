import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { expect } from 'chai';
import sinon from 'sinon';
import { EventConsumer, type ProcessedEventsTx, type Subscription } from '../../src';

class FakeChannel extends EventEmitter {
  acked = 0;
  nacked: boolean[] = [];
  consumeCb?: (m: any) => Promise<void>;
  throwOnAck = false;
  throwOnNack = false;
  async prefetch() {}
  async assertExchange() {}
  async assertQueue() {}
  async bindQueue() {}
  async consume(_q: string, cb: (m: any) => Promise<void>) {
    this.consumeCb = cb;
    return { consumerTag: 'c' };
  }
  ack() {
    if (this.throwOnAck) throw new Error('Channel closed');
    this.acked++;
  }
  nack(_m: unknown, _all: boolean, requeue: boolean) {
    if (this.throwOnNack) throw new Error('Channel closed');
    this.nacked.push(requeue);
  }
  async close() {
    this.emit('close');
  }
}

function fakeBroker() {
  const channels: FakeChannel[] = [];
  const callbacks: Array<() => Promise<void>> = [];
  const state = { connected: true };
  const broker: any = {
    onConnected: (cb: () => Promise<void>) => callbacks.push(cb),
    isConnected: () => state.connected,
    createChannel: async () => {
      const ch = new FakeChannel();
      channels.push(ch);
      return ch;
    },
    publish: async () => undefined,
  };
  return { broker, channels, callbacks, state };
}

const okTx = async <T>(fn: (tx: ProcessedEventsTx) => Promise<T>): Promise<T> =>
  fn({ processedEvent: { createMany: async () => ({ count: 1 }) } });

const envelope = (over: Record<string, unknown> = {}) => ({
  event_id: randomUUID(),
  type: 'JobVerified',
  version: 1,
  occurred_at: '2026-11-13T08:30:00.000Z',
  correlation_id: randomUUID(),
  producer: 'verification',
  payload: { job_id: 'j1' },
  ...over,
});

const delivery = (e: unknown) => ({
  content: Buffer.from(JSON.stringify(e)),
  fields: { deliveryTag: 1 },
  properties: { headers: {}, messageId: (e as any).event_id },
});

const sub = (handler: Subscription<ProcessedEventsTx>['handler']): Subscription<ProcessedEventsTx> => ({
  producer: 'verification',
  type: 'JobVerified',
  handler,
});

async function until(cond: () => boolean, label: string, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timeout: ${label}`);
}

async function build(opts: { onDeadLetter?: (i: any) => unknown; resubscribeDelayMs?: number } = {}) {
  const f = fakeBroker();
  const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
    service: 'notification',
    runInTransaction: okTx,
    resubscribeDelayMs: opts.resubscribeDelayMs ?? 10,
    onDeadLetter: opts.onDeadLetter as never,
  });
  return { ...f, consumer };
}

describe('EventConsumer hardening (ผลรีวิว)', () => {
  afterEach(() => sinon.restore());

  it('ack/nack ล้มเพราะ channel ปิดกลางงาน: onMessage ไม่ reject (ไม่ทำให้ process ล้มด้วย unhandled rejection)', async () => {
    const b = await build();
    await b.consumer.subscribe(sub(async () => undefined));
    const ch = b.channels[0];
    ch.throwOnAck = true;
    ch.throwOnNack = true;
    await ch.consumeCb!(delivery(envelope())); // ต้อง resolve
    await b.consumer.close();
  });

  it('onDeadLetter hook ที่ throw (หรือ reject): ยัง nack(requeue=false) ไม่วน requeue', async () => {
    for (const hook of [
      () => {
        throw new Error('hook failed');
      },
      () => Promise.reject(new Error('hook rejected')),
    ]) {
      const b = await build({ onDeadLetter: hook });
      await b.consumer.subscribe(sub(async () => undefined));
      await b.channels[0].consumeCb!(delivery(envelope({ version: 9 })));
      expect(b.channels[0].nacked).to.deep.equal([false]);
      await b.consumer.close();
    }
  });

  it('DLQ: log ระดับ error เสมอ แม้มี hook (ตรงกับ event-contract §3.3) และไม่มี payload', async () => {
    const errorLog = sinon.stub(Logger.prototype, 'error');
    const b = await build({ onDeadLetter: () => undefined });
    await b.consumer.subscribe(sub(async () => undefined));
    const secret = 'SECRET-PAYLOAD-xyz';
    const e = envelope({ version: 9, payload: { text: secret } });
    await b.channels[0].consumeCb!(delivery(e));
    const text = errorLog.getCalls().map((c) => String(c.args[0])).join('\n');
    expect(text).to.include('unsupported_version').and.include(e.event_id);
    expect(text).to.not.include(secret);
    await b.consumer.close();
  });

  it('handler ที่ล้ม: log ไม่มีข้อความ error (Prisma error ฝังค่าที่ query ได้) มีแค่ชื่อ/รหัส', async () => {
    const warn = sinon.stub(Logger.prototype, 'warn');
    const b = await build();
    const secret = 'SECRET-ROW-VALUE-xyz';
    await b.consumer.subscribe(
      sub(async () => {
        throw Object.assign(new Error(`Invalid value: ${secret}`), { code: 'P2002' });
      }),
    );
    await b.channels[0].consumeCb!(delivery(envelope()));
    const text = warn.getCalls().map((c) => String(c.args[0])).join('\n');
    expect(text).to.not.include(secret);
    expect(text).to.include('Error').and.include('P2002');
    await b.consumer.close();
  });

  it('channel ถูกปิดแต่ broker ยังต่ออยู่: subscribe ใหม่เองหลังหน่วง', async () => {
    const b = await build();
    await b.consumer.subscribe(sub(async () => undefined));
    expect(b.channels).to.have.length(1);
    b.channels[0].emit('close');
    await until(() => b.channels.length === 2, 'resubscribed on a new channel');
    expect(b.channels[1].consumeCb, 'channel ใหม่ต้อง consume').to.be.a('function');
    await b.consumer.close();
  });

  it('broker ไม่ได้ต่ออยู่ตอน channel ปิด: ไม่ subscribe ซ้ำ รอ onConnected แล้วจึง subscribe', async () => {
    const b = await build();
    await b.consumer.subscribe(sub(async () => undefined));
    b.state.connected = false;
    b.channels[0].emit('close');
    await new Promise((r) => setTimeout(r, 60));
    expect(b.channels).to.have.length(1);
    b.state.connected = true;
    await b.callbacks[0]();
    expect(b.channels).to.have.length(2);
    await b.consumer.close();
  });

  it('onConnected ขณะที่ยังมี channel ใช้งานอยู่: ไม่สร้าง subscription ซ้อน', async () => {
    const b = await build();
    await b.consumer.subscribe(sub(async () => undefined));
    await b.callbacks[0]();
    expect(b.channels).to.have.length(1);
    await b.consumer.close();
  });

  it('broker ยกเลิก consumer (msg = null): ปิด channel แล้ว subscribe ใหม่', async () => {
    const b = await build();
    await b.consumer.subscribe(sub(async () => undefined));
    await b.channels[0].consumeCb!(null);
    await until(() => b.channels.length === 2, 'resubscribed after cancel');
    await b.consumer.close();
  });

  it('close() แล้วไม่ subscribe ใหม่แม้ channel ปิด', async () => {
    const b = await build();
    await b.consumer.subscribe(sub(async () => undefined));
    await b.consumer.close();
    await new Promise((r) => setTimeout(r, 60));
    expect(b.channels).to.have.length(1);
  });
});
