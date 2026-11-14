import { readFileSync } from 'node:fs';
import path from 'node:path';
import { EVENT_CATALOG } from '@internpath/contracts';
import { expect } from 'chai';
import { DEFAULT_RETRY_DELAYS_MS, provisionAllTopology } from '../../src';

/** channel จำลอง: บันทึกการประกาศ exchange/queue/binding */
function fakeChannel() {
  const exchanges: string[] = [];
  const queues = new Map<string, Record<string, unknown> | undefined>();
  const bindings: Array<{ queue: string; exchange: string; key: string }> = [];
  const ch: any = {
    assertExchange: async (name: string) => void exchanges.push(name),
    assertQueue: async (name: string, o?: { arguments?: Record<string, unknown> }) => void queues.set(name, o?.arguments),
    bindQueue: async (queue: string, exchange: string, key: string) => void bindings.push({ queue, exchange, key }),
  };
  return { ch, exchanges, queues, bindings };
}

describe('EVENT_CATALOG เทียบกับ docs/event-contract.md §4', () => {
  const doc = readFileSync(path.resolve(__dirname, '../../../../docs/event-contract.md'), 'utf8');
  const section = doc.slice(doc.indexOf('## 4. สรุป Event ทั้งหมด'), doc.indexOf('## 5. Payload รายตัว'));
  const rows = [...section.matchAll(/^\|\s*(E\d+)\s*\|\s*`(\w+)`[^|]*\|\s*(\w+)\s*\|\s*([^|]+?)\s*\|/gm)].map((m) => ({
    id: m[1],
    type: m[2],
    producer: m[3],
    // "gateway (cache denylist), notification" → ชื่อ Service ตัวแรกของแต่ละรายการ
    consumers: m[4].split(',').map((c) => c.trim().split(/\s+/)[0]),
  }));

  it('ตารางในเอกสารมี 18 event และแคตตาล็อกตรงกันทุกแถว (id, ชนิด, ผู้ส่ง, ผู้รับ)', () => {
    expect(rows).to.have.length(18);
    expect(EVENT_CATALOG.map((e) => ({ id: e.id, type: e.type, producer: e.producer, consumers: [...e.consumers] }))).to.deep.equal(rows);
  });
});

describe('provisionAllTopology: สร้าง queue ของทุกผู้รับล่วงหน้า', () => {
  it('ประกาศ exchange พื้นฐานและคิวของผู้รับครบตามแคตตาล็อก (32 คิว) พร้อม binding จากผู้ส่ง', async () => {
    const { ch, exchanges, queues, bindings } = fakeChannel();
    const result = await provisionAllTopology(ch, EVENT_CATALOG);
    expect(exchanges).to.include.members(['internpath.events', 'internpath.dlx', 'internpath.retry-return']);

    const consumerQueues = EVENT_CATALOG.flatMap((e) => e.consumers.map((c) => ({ queue: `${c}.${e.type}`, key: `${e.producer}.${e.type}` })));
    expect(consumerQueues).to.have.length(32);
    expect(result.queues).to.have.members(consumerQueues.map((q) => q.queue));
    for (const { queue, key } of consumerQueues) {
      expect(queues.has(queue), queue).to.equal(true);
      expect(queues.has(`${queue}.dlq`), `${queue}.dlq`).to.equal(true);
      expect(bindings).to.deep.include({ queue, exchange: 'internpath.events', key });
    }
  });

  it('retry queue ร่วม 3 คิวต่อ Service ผู้รับ (ไม่ใช่ต่อ event) ตามข้อจำกัดคิวของ CloudAMQP', async () => {
    const { ch, queues } = fakeChannel();
    await provisionAllTopology(ch, EVENT_CATALOG);
    const services = new Set(EVENT_CATALOG.flatMap((e) => e.consumers));
    const retries = [...queues.keys()].filter((q) => /\.retry\.\d$/.test(q));
    expect(retries).to.have.length(services.size * DEFAULT_RETRY_DELAYS_MS.length);
    expect(services.has('gateway')).to.equal(true); // E16 มี Gateway เป็นผู้รับ
  });
});
