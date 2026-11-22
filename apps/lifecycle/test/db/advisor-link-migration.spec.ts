import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'chai';
import { Client } from 'pg';
import { createTestDatabase, type TestDatabase } from '../support/db';

const MIGRATION = path.resolve(
  __dirname,
  '../../prisma/migrations/20261122120000_advisor_link_pending_cleanup/migration.sql',
);

/*
 * Data migration แปลงแถว ADVISOR_LINK_PENDING ที่ค้างใน student_advisor_links (PM ตัดสิน 2026-11-22)
 * ฐานชั่วคราวถูก migrate ครบแล้ว (ตารางว่าง) ⇒ ใส่แถวค้างแล้วรัน SQL ของ migration ซ้ำ 2 รอบเพื่อตรวจผลและการรันซ้ำ
 */
describe('Lifecycle — migration แปลง ADVISOR_LINK_PENDING (Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let db: Client;

  before(async function () {
    database = await createTestDatabase('lc_linkmig');
    if (!database) this.skip();
    db = new Client({ connectionString: database.url });
    await db.connect();
  });

  after(async () => {
    await db?.end().catch(() => undefined);
    await database?.drop();
  });

  it('PENDING มีอาจารย์ ⇒ LINKED (อาจารย์เดิม) • ไม่มีอาจารย์ ⇒ NONE • แถวอื่นไม่เปลี่ยน • รันซ้ำได้', async () => {
    const advisor = randomUUID();
    const otherAdvisor = randomUUID();
    const rows = {
      pendingWithAdvisor: randomUUID(),
      pendingWithout: randomUUID(),
      linked: randomUUID(),
      none: randomUUID(),
    };
    const insert = (id: string, status: string, advisorId: string | null, version: number) =>
      db.query(
        `INSERT INTO student_advisor_links (student_user_id, advisor_user_id, link_status, entity_version, updated_at)
         VALUES ($1, $2, $3::advisor_link_status, $4, '2026-11-01T00:00:00Z')`,
        [id, advisorId, status, version],
      );
    await insert(rows.pendingWithAdvisor, 'ADVISOR_LINK_PENDING', advisor, 4);
    await insert(rows.pendingWithout, 'ADVISOR_LINK_PENDING', null, 2);
    await insert(rows.linked, 'LINKED', otherAdvisor, 3);
    await insert(rows.none, 'NONE', null, 1);

    const sql = readFileSync(MIGRATION, 'utf8');
    await db.query(sql);
    const afterFirst = await snapshot();
    await db.query(sql);
    expect(await snapshot()).to.deep.equal(afterFirst);

    expect(afterFirst.get(rows.pendingWithAdvisor)).to.include({ link_status: 'LINKED', advisor_user_id: advisor, entity_version: 4 });
    expect(afterFirst.get(rows.pendingWithout)).to.include({ link_status: 'NONE', advisor_user_id: null, entity_version: 2 });
    expect(afterFirst.get(rows.linked)).to.include({ link_status: 'LINKED', advisor_user_id: otherAdvisor, entity_version: 3 });
    expect(afterFirst.get(rows.none)).to.include({ link_status: 'NONE', advisor_user_id: null, entity_version: 1 });
    // แถวที่ไม่ได้แปลงไม่ถูกแตะ updated_at
    expect(afterFirst.get(rows.linked)?.updated_at.toISOString()).to.equal('2026-11-01T00:00:00.000Z');
    const { rows: left } = await db.query(`SELECT count(*)::int AS n FROM student_advisor_links WHERE link_status = 'ADVISOR_LINK_PENDING'`);
    expect(left[0].n).to.equal(0);
  });

  async function snapshot() {
    const { rows } = await db.query<{
      student_user_id: string;
      advisor_user_id: string | null;
      link_status: string;
      entity_version: number;
      updated_at: Date;
    }>('SELECT student_user_id, advisor_user_id, link_status, entity_version, updated_at FROM student_advisor_links');
    return new Map(rows.map((r) => [r.student_user_id, r]));
  }
});
