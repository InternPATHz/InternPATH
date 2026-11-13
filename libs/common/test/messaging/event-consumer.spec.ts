import { randomUUID } from 'node:crypto';
import type { EventEnvelope } from '@internpath/contracts';
import { expect } from 'chai';
import {
  EventConsumer,
  ORIGIN_QUEUE_HEADER,
  RETRY_COUNT_HEADER,
  processDelivery,
  type DeadLetterInfo,
  type ProcessedEventsTx,
  type Subscription,
} from '../../src';

const QUEUE = 'notification.JobVerified';

function envelope(over: Partial<EventEnvelope> & Record<string, unknown> = {}): EventEnvelope {
  return {
    event_id: randomUUID(),
    type: 'JobVerified',
    version: 1,
    occurred_at: '2026-11-13T08:30:00.000Z',
    correlation_id: randomUUID(),
    producer: 'verification',
    payload: { job_id: 'j1' },
    ...over,
  };
}

/** fake transaction: marker จะ commit ก็ต่อเมื่อ fn สำเร็จ (throw = rollback) */
function fakeStore() {
  const committed = new Set<string>();
  const state: { lastTx?: ProcessedEventsTx; txCalls: number } = { txCalls: 0 };
  const runInTransaction = async <T>(fn: (tx: ProcessedEventsTx) => Promise<T>): Promise<T> => {
    state.txCalls++;
    const pending: string[] = [];
    const tx: ProcessedEventsTx = {
      processedEvent: {
        createMany: async ({ data }) => {
          let count = 0;
          for (const d of data) {
            const k = `${d.consumer}|${d.eventId}`;
            if (committed.has(k) || pending.includes(k)) continue;
            pending.push(k);
            count++;
          }
          return { count };
        },
      },
    };
    state.lastTx = tx;
    const res = await fn(tx);
    pending.forEach((k) => committed.add(k));
    return res;
  };
  return { committed, state, runInTransaction };
}

function sub(handler: Subscription<ProcessedEventsTx>['handler']): Subscription<ProcessedEventsTx> {
  return { producer: 'verification', type: 'JobVerified', handler };
}

const raw = (e: unknown): Buffer => Buffer.from(typeof e === 'string' ? e : JSON.stringify(e));

describe('processDelivery', () => {
  it('ครั้งแรก: เรียก handler หนึ่งครั้งด้วย envelope และ tx เดียวกัน, บันทึก marker consumer = ชื่อคิว, ผล ack', async () => {
    const store = fakeStore();
    const e = envelope();
    const seen: Array<{ env: EventEnvelope; tx: ProcessedEventsTx }> = [];
    const outcome = await processDelivery({
      raw: raw(e),
      retryCount: 0,
      queue: QUEUE,
      maxRetries: 3,
      runInTransaction: store.runInTransaction,
      sub: sub(async (env, tx) => {
        seen.push({ env, tx });
      }),
    });
    expect(outcome).to.deep.equal({ kind: 'ack' });
    expect(seen).to.have.length(1);
    expect(seen[0].env.event_id).to.equal(e.event_id);
    expect(seen[0].tx).to.equal(store.state.lastTx);
    expect(store.committed.has(`${QUEUE}|${e.event_id}`)).to.equal(true);
  });

  it('ได้ event_id เดิมซ้ำ: handler ไม่ถูกเรียก, ผล ack', async () => {
    const store = fakeStore();
    const e = envelope();
    let calls = 0;
    const args = {
      raw: raw(e),
      retryCount: 0,
      queue: QUEUE,
      maxRetries: 3,
      runInTransaction: store.runInTransaction,
      sub: sub(async () => {
        calls++;
      }),
    };
    await processDelivery(args);
    const second = await processDelivery(args);
    expect(second).to.deep.equal({ kind: 'ack' });
    expect(calls).to.equal(1);
  });

  it('handler throw ที่ retryCount 0: ผล retry nextCount 1 และ marker ไม่ถูกบันทึก (rollback) จึงลองใหม่ได้', async () => {
    const store = fakeStore();
    const e = envelope();
    const outcome = await processDelivery({
      raw: raw(e),
      retryCount: 0,
      queue: QUEUE,
      maxRetries: 3,
      runInTransaction: store.runInTransaction,
      sub: sub(async () => {
        throw new Error('boom');
      }),
    });
    expect(outcome).to.deep.equal({ kind: 'retry', nextCount: 1 });
    expect(store.committed.size).to.equal(0);
  });

  it('handler throw ที่ retryCount 3 (maxRetries 3): dead-letter retries_exhausted', async () => {
    const store = fakeStore();
    const e = envelope();
    const outcome = await processDelivery({
      raw: raw(e),
      retryCount: 3,
      queue: QUEUE,
      maxRetries: 3,
      runInTransaction: store.runInTransaction,
      sub: sub(async () => {
        throw new Error('boom');
      }),
    });
    expect(outcome).to.deep.include({ kind: 'dead-letter', reason: 'retries_exhausted', eventId: e.event_id });
  });

  for (const [name, bad] of [
    ['JSON พัง', '{not json'],
    ['ไม่มี event_id', JSON.stringify({ ...envelope(), event_id: undefined })],
    ['type ไม่ตรง', JSON.stringify(envelope({ type: 'SomethingElse' }))],
    ['ไม่ใช่ object', '123'],
  ] as const) {
    it(`${name}: dead-letter invalid_message และ runInTransaction ไม่ถูกเรียก`, async () => {
      const store = fakeStore();
      const outcome = await processDelivery({
        raw: raw(bad),
        retryCount: 0,
        queue: QUEUE,
        maxRetries: 3,
        runInTransaction: store.runInTransaction,
        sub: sub(async () => undefined),
      });
      expect(outcome).to.deep.include({ kind: 'dead-letter', reason: 'invalid_message' });
      expect(store.state.txCalls).to.equal(0);
    });
  }

  it('version 2 เมื่อ supportedVersions [1]: dead-letter unsupported_version', async () => {
    const store = fakeStore();
    const outcome = await processDelivery({
      raw: raw(envelope({ version: 2 })),
      retryCount: 0,
      queue: QUEUE,
      maxRetries: 3,
      runInTransaction: store.runInTransaction,
      sub: sub(async () => undefined),
    });
    expect(outcome).to.deep.include({ kind: 'dead-letter', reason: 'unsupported_version' });
    expect(store.state.txCalls).to.equal(0);
  });

  it('envelope มีฟิลด์เพิ่มที่ไม่รู้จัก: ประมวลผลปกติ', async () => {
    const store = fakeStore();
    let called = 0;
    const outcome = await processDelivery({
      raw: raw(envelope({ future_field: { a: 1 }, payload: { job_id: 'j', new_optional: true } })),
      retryCount: 0,
      queue: QUEUE,
      maxRetries: 3,
      runInTransaction: store.runInTransaction,
      sub: sub(async () => {
        called++;
      }),
    });
    expect(outcome).to.deep.equal({ kind: 'ack' });
    expect(called).to.equal(1);
  });
});

/** fake broker + channel: บันทึกลำดับการเรียกทั้งหมดไว้ใน `order` */
function fakeBroker(opts: { publishFails?: boolean } = {}) {
  const order: string[] = [];
  const acked: unknown[] = [];
  const nacked: Array<{ requeue: boolean }> = [];
  const published: Array<{ exchange: string; key: string; body: Buffer; options: any }> = [];
  let deliver: ((m: any) => Promise<void>) | undefined;
  const ch: any = {
    on: () => undefined,
    prefetch: async () => undefined,
    assertExchange: async () => undefined,
    assertQueue: async () => undefined,
    bindQueue: async () => undefined,
    consume: async (_q: string, cb: (m: any) => Promise<void>) => {
      deliver = cb;
      return { consumerTag: 'c' };
    },
    ack: (m: unknown) => {
      order.push('ack');
      acked.push(m);
    },
    nack: (_m: unknown, _all: boolean, requeue: boolean) => {
      order.push('nack');
      nacked.push({ requeue });
    },
    close: async () => undefined,
  };
  const callbacks: Array<() => Promise<void>> = [];
  const broker: any = {
    onConnected: (cb: () => Promise<void>) => callbacks.push(cb),
    isConnected: () => true,
    createChannel: async () => ch,
    publish: async (exchange: string, key: string, body: Buffer, options: any) => {
      order.push('publish');
      if (opts.publishFails) throw new Error('publish failed');
      published.push({ exchange, key, body, options });
    },
  };
  const msg = (e: unknown, headers: Record<string, unknown> = {}) => ({
    content: raw(e),
    fields: { deliveryTag: 1 },
    properties: { headers, messageId: (e as any)?.event_id },
  });
  return { broker, order, acked, nacked, published, msg, deliver: (m: any) => deliver!(m), callbacks };
}

describe('EventConsumer', () => {
  it('ack ถูกเรียกหลัง runInTransaction resolve เท่านั้น (ลำดับ: transaction → ack)', async () => {
    const f = fakeBroker();
    const store = fakeStore();
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'notification',
      runInTransaction: async (fn) => {
        f.order.push('tx-start');
        const r = await store.runInTransaction(fn);
        f.order.push('tx-end');
        return r;
      },
    });
    await consumer.subscribe(sub(async () => void f.order.push('handler')));
    await f.deliver(f.msg(envelope()));
    expect(f.order).to.deep.equal(['tx-start', 'handler', 'tx-end', 'ack']);
  });

  it('outcome retry: publish ไป <service>.retry.<nextCount> พร้อม x-retry-count และ origin-queue แล้วจึง ack ต้นฉบับ', async () => {
    const f = fakeBroker();
    const store = fakeStore();
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'notification',
      runInTransaction: store.runInTransaction,
    });
    await consumer.subscribe(
      sub(async () => {
        throw new Error('boom');
      }),
    );
    const e = envelope();
    await f.deliver(f.msg(e, { [RETRY_COUNT_HEADER]: 1 }));
    expect(f.published).to.have.length(1);
    expect(f.published[0].exchange).to.equal('');
    expect(f.published[0].key).to.equal('notification.retry.2');
    expect(f.published[0].options.headers[RETRY_COUNT_HEADER]).to.equal(2);
    expect(f.published[0].options.headers[ORIGIN_QUEUE_HEADER]).to.equal(QUEUE);
    expect(f.published[0].body.toString()).to.equal(JSON.stringify(e));
    expect(f.order).to.deep.equal(['publish', 'ack']);
  });

  it('retry แต่ publish ล้ม: ไม่ ack ต้นฉบับ แต่ nack(requeue) เพื่อไม่ให้ข้อความหาย', async () => {
    const f = fakeBroker({ publishFails: true });
    const store = fakeStore();
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'notification',
      runInTransaction: store.runInTransaction,
    });
    await consumer.subscribe(
      sub(async () => {
        throw new Error('boom');
      }),
    );
    await f.deliver(f.msg(envelope()));
    expect(f.acked).to.have.length(0);
    expect(f.nacked).to.deep.equal([{ requeue: true }]);
  });

  it('outcome dead-letter: nack(requeue=false) และเรียก onDeadLetter โดย info ไม่มี payload', async () => {
    const f = fakeBroker();
    const store = fakeStore();
    const infos: DeadLetterInfo[] = [];
    const consumer = new EventConsumer<ProcessedEventsTx>(f.broker, {
      service: 'notification',
      runInTransaction: store.runInTransaction,
      onDeadLetter: (i) => infos.push(i),
    });
    await consumer.subscribe(sub(async () => undefined));
    const secret = 'SECRET-PAYLOAD-xyz';
    const bad = envelope({ version: 9, payload: { text: secret } });
    await f.deliver(f.msg(bad));
    expect(f.nacked).to.deep.equal([{ requeue: false }]);
    expect(infos).to.have.length(1);
    expect(infos[0]).to.include({ queue: QUEUE, reason: 'unsupported_version', eventId: bad.event_id });
    expect(JSON.stringify(infos[0])).to.not.include(secret);
  });
});
