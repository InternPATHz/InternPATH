import { randomUUID } from 'node:crypto';
import { EVENTS_EXCHANGE } from '@internpath/contracts';
import { expect } from 'chai';
import {
  OutboxRelay,
  nextRelayDelayMs,
  type EventPublisher,
  type OutboxRow,
  type RelayDb,
} from '../../src';

function row(type: string, createdAt: string, payload: unknown = { n: 1 }): OutboxRow {
  return {
    id: randomUUID(),
    type,
    version: 1,
    aggregate_id: randomUUID(),
    payload,
    correlation_id: randomUUID(),
    created_at: new Date(createdAt),
  };
}

interface Stmt {
  sql: string;
  params?: unknown[];
}

/** fake pg: บันทึก SQL ทุกคำสั่ง ตอบตามชนิดของคำสั่ง */
function fakeDb(opts: { rows?: OutboxRow[]; lock?: boolean; failWhen?: (sql: string, n: number) => boolean } = {}) {
  const stmts: Stmt[] = [];
  let n = 0;
  const db: RelayDb = {
    async query(sql, params) {
      stmts.push({ sql, params });
      if (opts.failWhen?.(sql, n++)) throw new Error('db down');
      if (sql.includes('pg_try_advisory_xact_lock')) return { rows: [{ locked: opts.lock ?? true }] };
      if (/^\s*SELECT/i.test(sql)) return { rows: opts.rows ?? [] };
      return { rows: [] };
    },
  };
  const verbs = () => stmts.map((s) => s.sql.trim().split(/\s+/)[0].toUpperCase());
  return { db, stmts, verbs };
}

function fakePublisher(failOnCall?: number) {
  const calls: Array<{ exchange: string; key: string; body: Buffer; options: any }> = [];
  const publisher: EventPublisher = {
    async publish(exchange, key, body, options) {
      calls.push({ exchange, key, body, options });
      if (failOnCall !== undefined && calls.length === failOnCall) throw new Error('broker down');
    },
  };
  return { publisher, calls };
}

describe('OutboxRelay', () => {
  it('publish ตามลำดับ created_at ด้วย exchange EVENTS_EXCHANGE, routingKey job.JobSubmitted, messageId=event_id, persistent, header x-correlation-id และ mark ทีละแถว', async () => {
    const r1 = row('JobSubmitted', '2026-11-13T08:00:00Z');
    const r2 = row('JobSubmitted', '2026-11-13T08:00:01Z');
    const { db, stmts } = fakeDb({ rows: [r1, r2] });
    const { publisher, calls } = fakePublisher();
    const relay = new OutboxRelay({ service: 'job', db, publisher });

    const sent = await relay.runOnce();

    expect(sent).to.equal(2);
    expect(calls.map((c) => c.options.messageId)).to.deep.equal([r1.id, r2.id]);
    expect(calls[0].exchange).to.equal(EVENTS_EXCHANGE);
    expect(calls[0].key).to.equal('job.JobSubmitted');
    expect(calls[0].options.contentType).to.equal('application/json');
    expect(calls[0].options.deliveryMode).to.equal(2);
    expect(calls[0].options.headers['x-correlation-id']).to.equal(r1.correlation_id);
    const env = JSON.parse(calls[0].body.toString());
    expect(env).to.include({ event_id: r1.id, type: 'JobSubmitted', producer: 'job', version: 1 });
    expect(env.occurred_at).to.equal('2026-11-13T08:00:00.000Z');

    const marks = stmts.filter((s) => s.sql.includes('published_at = now()'));
    expect(marks.map((m) => m.params?.[0])).to.deep.equal([r1.id, r2.id]);
    const order = stmts.map((s) => s.sql);
    expect(order[0]).to.match(/BEGIN/i);
    expect(order[1]).to.include('pg_try_advisory_xact_lock');
    expect(order[order.length - 1]).to.match(/COMMIT/i);
    expect(order.find((s) => /^\s*SELECT\s+id/i.test(s))).to.match(/ORDER BY created_at, id/i);
  });

  it('หยุดที่แถวแรกที่ publish ล้ม: แถวหลังไม่ถูกส่ง, แถวที่ล้มได้ attempts+1, แถวก่อนหน้าถูก mark และ COMMIT, คืนจำนวนที่ส่งสำเร็จ', async () => {
    const rows = [
      row('A', '2026-11-13T08:00:00Z'),
      row('B', '2026-11-13T08:00:01Z'),
      row('C', '2026-11-13T08:00:02Z'),
    ];
    const { db, stmts, verbs } = fakeDb({ rows });
    const { publisher, calls } = fakePublisher(2);
    const relay = new OutboxRelay({ service: 'job', db, publisher });

    const sent = await relay.runOnce();

    expect(sent).to.equal(1);
    expect(calls).to.have.length(2); // C ไม่ถูกลองส่ง
    const marked = stmts.filter((s) => s.sql.includes('published_at = now()')).map((s) => s.params?.[0]);
    expect(marked).to.deep.equal([rows[0].id]);
    const failed = stmts.filter(
      (s) => s.sql.includes('attempts = attempts + 1') && !s.sql.includes('published_at'),
    );
    expect(failed.map((s) => s.params?.[0])).to.deep.equal([rows[1].id]);
    expect(verbs()[verbs().length - 1]).to.equal('COMMIT');
  });

  it('ถ้าได้ advisory lock ไม่สำเร็จ (replica ตัวที่สอง): ไม่ SELECT ไม่ publish, ROLLBACK, คืน 0', async () => {
    const { db, stmts, verbs } = fakeDb({ lock: false, rows: [row('A', '2026-11-13T08:00:00Z')] });
    const { publisher, calls } = fakePublisher();
    const relay = new OutboxRelay({ service: 'job', db, publisher });

    expect(await relay.runOnce()).to.equal(0);
    expect(calls).to.have.length(0);
    expect(stmts.some((s) => /^\s*SELECT\s+id/i.test(s.sql))).to.equal(false);
    expect(verbs()[verbs().length - 1]).to.equal('ROLLBACK');
  });

  it('ถ้า query ล้มระหว่างทำงาน: ROLLBACK แล้ว throw ต่อ', async () => {
    const { db, verbs } = fakeDb({ failWhen: (sql) => /^\s*SELECT\s+id/i.test(sql) });
    const { publisher } = fakePublisher();
    const relay = new OutboxRelay({ service: 'job', db, publisher });

    let err: Error | undefined;
    try {
      await relay.runOnce();
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal('db down');
    expect(verbs()[verbs().length - 1]).to.equal('ROLLBACK');
  });

  it('nextRelayDelayMs: ส่งได้ >0 แถว → 2000, ไม่มีงาน → 10000', () => {
    const o = { busyIntervalMs: 2000, idleIntervalMs: 10000 };
    expect(nextRelayDelayMs(3, o)).to.equal(2000);
    expect(nextRelayDelayMs(0, o)).to.equal(10000);
  });

  it('start() ทำงานต่อหลัง db.query reject (Postgres ล่ม): log แล้วลองรอบถัดไป ไม่ throw ออกนอก loop', async () => {
    const r = row('A', '2026-11-13T08:00:00Z');
    let begins = 0;
    const { db } = fakeDb({
      rows: [r],
      failWhen: (sql) => /^\s*BEGIN/i.test(sql) && ++begins <= 2,
    });
    const { publisher, calls } = fakePublisher();
    const logs: string[] = [];
    const relay = new OutboxRelay({
      service: 'job',
      db,
      publisher,
      busyIntervalMs: 5,
      idleIntervalMs: 5,
      logger: { warn: (m: string) => logs.push(m), error: (m: string) => logs.push(m), debug: () => undefined },
    });

    relay.start();
    const end = Date.now() + 2000;
    while (Date.now() < end && calls.length === 0) await new Promise((res) => setTimeout(res, 5));
    await relay.stop();

    expect(calls.length).to.be.greaterThan(0);
    expect(logs.some((l) => l.includes('db down'))).to.equal(true);
  });

  it('stop() รอรอบที่ค้างอยู่จบแล้วไม่เรียก db อีก', async () => {
    const { db, stmts } = fakeDb();
    const { publisher } = fakePublisher();
    const relay = new OutboxRelay({ service: 'job', db, publisher, busyIntervalMs: 5, idleIntervalMs: 5 });
    relay.start();
    await new Promise((res) => setTimeout(res, 40));
    await relay.stop();
    const after = stmts.length;
    await new Promise((res) => setTimeout(res, 60));
    expect(stmts.length).to.equal(after);
  });

  it('log ไม่มี payload ของ event', async () => {
    const secret = 'SECRET-PAYLOAD-xyz';
    const { db } = fakeDb({ rows: [row('ReviewSubmitted', '2026-11-13T08:00:00Z', { text: secret })] });
    const { publisher } = fakePublisher(1);
    const logs: string[] = [];
    const sink = (m: string) => logs.push(String(m));
    const relay = new OutboxRelay({
      service: 'lifecycle',
      db,
      publisher,
      logger: { warn: sink, error: sink, debug: sink },
    });

    await relay.runOnce();

    expect(logs.length).to.be.greaterThan(0);
    expect(logs.join('\n')).to.not.include(secret);
    expect(logs.join('\n')).to.include('broker down');
  });
});
