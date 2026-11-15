import { EventEmitter } from 'node:events';
import { expect } from 'chai';
import sinon from 'sinon';
import { Logger } from '@nestjs/common';
import { EventConsumer, type ProcessedEventsTx, type Subscription } from '../../src';

/**
 * Regression: การ recover หลัง broker ปิด channel (เช่น 406 PRECONDITION_FAILED จาก queue ที่ประกาศไม่ตรง)
 * ต้องเหลือ consumer เพียงตัวเดียวต่อ subscription
 *
 * เดิม `setup()` ตั้ง `state.live` หลัง `consume()` เสร็จเท่านั้น และ resubscribe ถูกนัดได้จากสองทางพร้อมกัน
 * (handler 'close' ของ channel ที่ setup ไม่สำเร็จ + catch ของ run) จึงมีสอง setup ซ้อนกันและได้ consumer 2 ตัว
 */
class FakeChannel extends EventEmitter {
  consuming = false;
  closed = false;
  constructor(readonly id: number, private readonly failAssert: boolean) { super(); }
  async prefetch() {}
  async assertExchange() {}
  async assertQueue() {
    if (this.failAssert) {
      // broker ตอบ 406 แล้วปิด channel เอง
      this.closed = true;
      setImmediate(() => this.emit('close'));
      throw new Error('PRECONDITION_FAILED - inequivalent arg');
    }
  }
  async bindQueue() {}
  async consume() {
    this.consuming = true;
    return { consumerTag: `c${this.id}` };
  }
  ack() {}
  nack() {}
  async close() {
    if (this.closed) return;
    this.closed = true;
    this.consuming = false;
    this.emit('close');
  }
}

function fakeBroker(opts: { createDelayMs: number; failNext: () => boolean }) {
  const channels: FakeChannel[] = [];
  const callbacks: Array<() => Promise<void>> = [];
  const broker: any = {
    onConnected: (cb: () => Promise<void>) => callbacks.push(cb),
    isConnected: () => true,
    createChannel: async () => {
      // การสร้าง channel ใช้เวลา — เปิดช่องให้ setup สองตัวซ้อนกันได้เหมือนใช้ broker จริง
      await new Promise((r) => setTimeout(r, opts.createDelayMs));
      const ch = new FakeChannel(channels.length + 1, opts.failNext());
      channels.push(ch);
      return ch;
    },
    publish: async () => undefined,
  };
  return { broker, channels, callbacks };
}

const sub: Subscription<ProcessedEventsTx> = { producer: 'identity', type: 'CompanyStatusChanged', handler: async () => undefined };

const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('EventConsumer: resubscribe ซ้อน (ผล Independent Audit ของ Job)', () => {
  afterEach(() => sinon.restore());

  it('setup ล้ม (406) แล้วช่อง recovery ลองใหม่: เหลือ consumer เดียว ไม่ใช่สอง', async () => {
    sinon.stub(Logger.prototype, 'error');
    sinon.stub(Logger.prototype, 'warn');
    let failureArmed = false;
    const f = fakeBroker({ createDelayMs: 20, failNext: () => { const v = failureArmed; failureArmed = false; return v; } });
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'job',
      runInTransaction: async (fn) => fn({ processedEvent: { createMany: async () => ({ count: 1 }) } }),
      resubscribeDelayMs: 30,
    });

    await consumer.subscribe(sub);
    expect(f.channels.filter((c) => c.consuming)).to.have.length(1);

    // broker ปิด channel ที่ใช้งานอยู่ แล้ว recovery รอบแรกชน 406 (channel ใหม่ถูกปิดโดย broker)
    failureArmed = true;
    f.channels[0].closed = true;
    f.channels[0].consuming = false;
    f.channels[0].emit('close');

    await settle(600); // ให้ timer ทุกใบยิงและ setup จบ
    const active = f.channels.filter((c) => c.consuming);
    expect(active.map((c) => c.id), `channel ที่ consume อยู่ (สร้างทั้งหมด ${f.channels.length})`).to.have.length(1);
    await consumer.close();
  });

  it('onConnected ยิงซ้ำระหว่างที่ setup ยังไม่จบ: ไม่สร้าง subscription ซ้อน', async () => {
    const f = fakeBroker({ createDelayMs: 20, failNext: () => false });
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'job',
      runInTransaction: async (fn) => fn({ processedEvent: { createMany: async () => ({ count: 1 }) } }),
      resubscribeDelayMs: 30,
    });
    const first = consumer.subscribe(sub);
    // broker ต่อใหม่ (onConnected) ขณะ setup แรกยังรอสร้าง channel
    await settle(5);
    await Promise.all(f.callbacks.map((cb) => cb()));
    await first;
    await settle(100);
    expect(f.channels.filter((c) => c.consuming)).to.have.length(1);
    await consumer.close();
  });

  it('close() ระหว่างที่ resubscribe ค้างอยู่: ไม่เหลือ consumer หรือ timer', async () => {
    sinon.stub(Logger.prototype, 'warn');
    const f = fakeBroker({ createDelayMs: 20, failNext: () => false });
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'job',
      runInTransaction: async (fn) => fn({ processedEvent: { createMany: async () => ({ count: 1 }) } }),
      resubscribeDelayMs: 30,
    });
    await consumer.subscribe(sub);
    f.channels[0].closed = true;
    f.channels[0].consuming = false;
    f.channels[0].emit('close');
    await consumer.close();
    await settle(200);
    expect(f.channels.filter((c) => c.consuming)).to.have.length(0);
  });
});
