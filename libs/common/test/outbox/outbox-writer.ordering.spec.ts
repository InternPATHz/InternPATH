import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { OutboxWriter, type OutboxCreateData, type OutboxTx } from '../../src';

describe('OutboxWriter ordering (ผลรีวิว)', () => {
  it('createdAt เพิ่มขึ้นเข้มงวดข้ามการเรียก add ติดกัน แม้อยู่ใน ms เดียวกัน (เหตุการณ์ใน Transaction เดียวกันต้องเรียงถูก)', async () => {
    const rows: OutboxCreateData[] = [];
    const tx: OutboxTx = {
      outboxEvent: {
        create: async ({ data }) => {
          rows.push(data);
          return data;
        },
      },
    };
    const writer = new OutboxWriter();
    const aggregateId = randomUUID();
    const before = Date.now();
    for (let i = 0; i < 50; i++) {
      await writer.add(tx, { type: 'T', aggregateId, correlationId: randomUUID(), payload: { i } });
    }
    const times = rows.map((r) => r.createdAt.getTime());
    for (let i = 1; i < times.length; i++) {
      expect(times[i], `row ${i}`).to.be.greaterThan(times[i - 1]);
    }
    expect(times[0]).to.be.at.least(before);
    expect(times[times.length - 1]).to.be.lessThan(Date.now() + 1000); // ไม่เลื่อนเวลาไปอนาคตไกล
  });
});
