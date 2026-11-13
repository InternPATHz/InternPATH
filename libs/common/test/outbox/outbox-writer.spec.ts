import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { OutboxWriter, type OutboxCreateData, type OutboxTx } from '../../src';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function fakeTx() {
  const calls: OutboxCreateData[] = [];
  const tx: OutboxTx = {
    outboxEvent: {
      create: async (args) => {
        calls.push(args.data);
        return args.data;
      },
    },
  };
  return { tx, calls };
}

describe('OutboxWriter', () => {
  const writer = new OutboxWriter();

  it('add เรียก tx.outboxEvent.create หนึ่งครั้ง ด้วย id เป็น UUID v4, version เริ่มต้น 1 และคืน id เดียวกัน', async () => {
    const { tx, calls } = fakeTx();
    const aggregateId = randomUUID();
    const correlationId = randomUUID();
    const id = await writer.add(tx, {
      type: 'JobSubmitted',
      aggregateId,
      correlationId,
      payload: { a: 1 },
    });
    expect(calls).to.have.length(1);
    expect(calls[0].id).to.match(UUID_V4);
    expect(id).to.equal(calls[0].id);
    expect(calls[0].version).to.equal(1);
    expect(calls[0].type).to.equal('JobSubmitted');
    expect(calls[0].aggregateId).to.equal(aggregateId);
    expect(calls[0].payload).to.deep.equal({ a: 1 });
  });

  it('ใช้ correlationId เดิมถ้าเป็น UUID', async () => {
    const { tx, calls } = fakeTx();
    const correlationId = randomUUID();
    await writer.add(tx, { type: 'T', aggregateId: randomUUID(), correlationId, payload: {} });
    expect(calls[0].correlationId).to.equal(correlationId);
  });

  it("แทน correlationId ที่ไม่ใช่ UUID (เช่น 'abc-123') ด้วย UUID ใหม่ แทนที่จะส่งค่าเดิมเข้า DB", async () => {
    const { tx, calls } = fakeTx();
    await writer.add(tx, { type: 'T', aggregateId: randomUUID(), correlationId: 'abc-123', payload: {} });
    expect(calls[0].correlationId).to.match(UUID_V4);
    expect(calls[0].correlationId).to.not.equal('abc-123');
  });

  it('ปฏิเสธเมื่อ aggregateId ว่าง/ไม่ใช่ UUID ก่อนเรียก tx', async () => {
    const { tx, calls } = fakeTx();
    for (const bad of ['', 'not-a-uuid']) {
      let err: Error | undefined;
      try {
        await writer.add(tx, { type: 'T', aggregateId: bad, correlationId: randomUUID(), payload: {} });
      } catch (e) {
        err = e as Error;
      }
      expect(err, `aggregateId=${JSON.stringify(bad)}`).to.be.instanceOf(Error);
      expect(err!.message).to.match(/aggregateId/);
    }
    expect(calls).to.have.length(0);
  });
});
