import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { Client } from 'pg';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const EXPECTED_TABLES = [
  'admin_audit_log',
  'appeals',
  'blacklist_terms',
  'company_snapshots',
  'evaluations',
  'negation_cues',
  'outbox_events',
  'processed_events',
  'queue_items',
  'risk_rules',
  'status_history',
];

describe('verification_db schema (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let pg: Client;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    pg = new Client({ connectionString: db.url });
    await pg.connect();
  });

  after(async () => {
    await pg?.end().catch(() => undefined);
    await db?.drop();
  });

  const count = async (table: string, where = 'true'): Promise<number> =>
    Number((await pg.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n);

  it('migrate deploy ผ่านบนฐานข้อมูลเปล่า และตารางครบ 11 ตาราง', async () => {
    const rows = (
      await pg.query(
        `SELECT table_name FROM information_schema.tables
          WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
      )
    ).rows.map((r) => r.table_name);
    expect(rows).to.deep.equal(EXPECTED_TABLES);
  });

  it('seed: 17 HARD + 6 SOFT, negation_cues 8, risk_rules 8 แถว', async () => {
    expect(await count('blacklist_terms', "severity = 'HARD'")).to.equal(17);
    expect(await count('blacklist_terms', "severity = 'SOFT'")).to.equal(6);
    expect(await count('negation_cues')).to.equal(8);
    expect(await count('risk_rules')).to.equal(8);
  });

  it('seed ซ้ำ (รัน SQL seed อีกรอบ) ไม่เพิ่มแถวและไม่ทับค่าที่แก้', async () => {
    await pg.query("UPDATE risk_rules SET weight = 99 WHERE code = 'CONTACT_IN_TEXT'");
    await pg.query("UPDATE blacklist_terms SET enabled = false WHERE term = 'ลงทุน'");
    const dir = path.resolve(__dirname, '../../prisma/migrations');
    const seed = readdirSync(dir).find((d) => d.endsWith('_seed_defaults'));
    expect(seed, 'ต้องมี migration *_seed_defaults').to.be.a('string');
    await pg.query(readFileSync(path.join(dir, seed!, 'migration.sql'), 'utf8'));
    expect(await count('blacklist_terms')).to.equal(23);
    expect(await count('negation_cues')).to.equal(8);
    expect(await count('risk_rules')).to.equal(8);
    expect(await count('risk_rules', "code = 'CONTACT_IN_TEXT' AND weight = 99")).to.equal(1);
    expect(await count('blacklist_terms', "term = 'ลงทุน' AND enabled = false")).to.equal(1);
  });

  it('partial unique index: เปิดรายการ type/target_id เดียวกันซ้อนไม่ได้ แต่ได้เมื่อรายการเดิม RESOLVED', async () => {
    const target = randomUUID();
    const insert = () =>
      pg.query(
        `INSERT INTO queue_items (type, target_type, target_id, priority, is_appeal, origin, due_at, status)
         VALUES ('JOB_REVIEW', 'job', $1, 'NORMAL', false, 'EVALUATION', now(), 'OPEN')`,
        [target],
      );
    await insert();
    let err: { code?: string } | undefined;
    try {
      await insert();
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).to.equal('23505');
    await pg.query("UPDATE queue_items SET status = 'RESOLVED', resolved_at = now() WHERE target_id = $1", [target]);
    await insert(); // ไม่ throw
    expect(await count('queue_items', `target_id = '${target}'`)).to.equal(2);
  });

  it('status_history และ admin_audit_log: UPDATE และ DELETE ถูกปฏิเสธ (append-only)', async () => {
    await pg.query(
      `INSERT INTO status_history (entity, entity_id, to_status, actor_role, correlation_id)
       VALUES ('QUEUE_ITEM', $1, 'OPEN', 'SYSTEM', $2)`,
      [randomUUID(), randomUUID()],
    );
    await pg.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, correlation_id)
       VALUES ($1, 'TEST', 'x', $2, $3)`,
      [randomUUID(), randomUUID(), randomUUID()],
    );
    for (const sql of [
      "UPDATE status_history SET to_status = 'X'",
      'DELETE FROM status_history',
      "UPDATE admin_audit_log SET action = 'X'",
      'DELETE FROM admin_audit_log',
    ]) {
      let message = '';
      try {
        await pg.query(sql);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, sql).to.match(/append-only/i);
    }
  });

  it('evaluations.submission_id และ appeals.job_id เป็น UNIQUE', async () => {
    const defs = (
      await pg.query(
        `SELECT tablename, indexdef FROM pg_indexes
          WHERE tablename IN ('evaluations','appeals') AND indexdef ILIKE '%UNIQUE%'`,
      )
    ).rows.map((r) => `${r.tablename}: ${r.indexdef}`);
    expect(defs.some((d) => d.startsWith('evaluations:') && d.includes('(submission_id)'))).to.equal(true);
    expect(defs.some((d) => d.startsWith('appeals:') && d.includes('(job_id)'))).to.equal(true);
  });
});
