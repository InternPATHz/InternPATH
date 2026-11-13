import { EventEmitter } from 'node:events';
import { expect } from 'chai';
import { PgRelayDb, type PgClientLike } from '../../src';

class FakeClient extends EventEmitter implements PgClientLike {
  ended = false;
  constructor(
    readonly id: number,
    private readonly failConnect = false,
  ) {
    super();
  }
  async connect(): Promise<void> {
    if (this.failConnect) throw new Error('connect refused');
  }
  async query(): Promise<{ rows: any[] }> {
    return { rows: [{ id: this.id }] };
  }
  async end(): Promise<void> {
    this.ended = true;
  }
}

describe('PgRelayDb', () => {
  it('ใช้ client เดียวต่อเนื่อง และต่อ client ใหม่หลัง client เดิม error (Postgres restart)', async () => {
    const made: FakeClient[] = [];
    const db = new PgRelayDb('postgresql://x', () => {
      const c = new FakeClient(made.length + 1);
      made.push(c);
      return c;
    });
    expect((await db.query('SELECT 1')).rows[0].id).to.equal(1);
    expect((await db.query('SELECT 1')).rows[0].id).to.equal(1);
    expect(made).to.have.length(1);

    made[0].emit('error', new Error('connection lost'));
    expect((await db.query('SELECT 1')).rows[0].id).to.equal(2);
    expect(made[0].ended).to.equal(true);
  });

  it('connect ล้มเหลว: query reject แต่ครั้งถัดไปลองต่อ client ใหม่ (ไม่ค้างสถานะเสีย)', async () => {
    let n = 0;
    const db = new PgRelayDb('postgresql://x', () => new FakeClient(++n, n === 1));
    let err: Error | undefined;
    try {
      await db.query('SELECT 1');
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal('connect refused');
    expect((await db.query('SELECT 1')).rows[0].id).to.equal(2);
  });

  it('close() ปิด client ที่เปิดอยู่', async () => {
    const made: FakeClient[] = [];
    const db = new PgRelayDb('postgresql://x', () => {
      const c = new FakeClient(made.length + 1);
      made.push(c);
      return c;
    });
    await db.query('SELECT 1');
    await db.close();
    expect(made[0].ended).to.equal(true);
  });
});
