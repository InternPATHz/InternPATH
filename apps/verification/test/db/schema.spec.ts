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
  'company_flags',
  'company_rejection_events',
  'company_snapshots',
  'evaluations',
  'job_report_counters',
  'job_reports',
  'job_snapshots',
  'negation_cues',
  'outbox_events',
  'processed_events',
  'queue_items',
  'reporter_stats',
  'review_moderations',
  'review_reports',
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

  it('migrate deploy ผ่านบนฐานข้อมูลเปล่า และตารางครบ 19 ตาราง', async () => {
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

  describe('Authorized Anonymization Operation (data-schema §2.3)', () => {
    const actor = randomUUID();
    const anonymous = randomUUID();

    const seedRows = async (): Promise<{ historyId: string; auditId: string }> => {
      const history = await pg.query(
        `INSERT INTO status_history (entity, entity_id, to_status, actor_id, actor_role, correlation_id)
         VALUES ('QUEUE_ITEM', $1, 'OPEN', $2, 'PLATFORM_ADMIN', $3) RETURNING id`,
        [randomUUID(), actor, randomUUID()],
      );
      const audit = await pg.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, correlation_id)
         VALUES ($1, 'TEST', 'x', $2, $3) RETURNING id`,
        [actor, randomUUID(), randomUUID()],
      );
      return { historyId: history.rows[0].id, auditId: audit.rows[0].id };
    };

    /** รัน sql ใน Transaction ที่ตั้งค่า setting (ตามที่ระบุ) แล้วคืนข้อความ error ('' เมื่อผ่าน) — rollback เสมอเพื่อไม่ให้เทสต์กระทบกัน */
    const attempt = async (sql: string, params: unknown[], settings: Record<string, string> = {}): Promise<string> => {
      await pg.query('BEGIN');
      try {
        for (const [name, value] of Object.entries(settings)) await pg.query('SELECT set_config($1, $2, true)', [name, value]);
        await pg.query(sql, params);
        return '';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await pg.query('ROLLBACK');
      }
    };

    const both = { 'internpath.anonymize': 'on', 'internpath.anonymous_actor_id': anonymous };

    it('ผ่าน: เปลี่ยนเฉพาะ actor_id/admin_id เป็น anonymous_actor_id ใน Transaction ที่ตั้งครบทั้งสอง setting', async () => {
      const { historyId, auditId } = await seedRows();
      expect(await attempt('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, historyId], both)).to.equal('');
      expect(await attempt('UPDATE admin_audit_log SET admin_id = $1 WHERE id = $2', [anonymous, auditId], both)).to.equal('');
    });

    it('ผ่านแล้วค่าต้องเปลี่ยนจริงเมื่อ COMMIT และ setting หมดอายุพร้อม Transaction (ไม่ค้างข้ามคำสั่งถัดไป)', async () => {
      const { historyId } = await seedRows();
      await pg.query('BEGIN');
      try {
        for (const [n, v] of Object.entries(both)) await pg.query('SELECT set_config($1, $2, true)', [n, v]);
        await pg.query('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, historyId]);
        await pg.query('COMMIT');
      } catch (e) {
        await pg.query('ROLLBACK');
        throw e;
      }
      expect((await pg.query('SELECT actor_id FROM status_history WHERE id = $1', [historyId])).rows[0].actor_id).to.equal(anonymous);
      let message = '';
      try {
        await pg.query("UPDATE status_history SET to_status = 'X' WHERE id = $1", [historyId]);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message).to.match(/append-only/i);
    });

    it('ปฏิเสธ: ไม่มี setting, มีแค่ anonymize, มีแค่ anonymous_actor_id, หรือ anonymize ไม่ใช่ on', async () => {
      const { historyId } = await seedRows();
      const sql = 'UPDATE status_history SET actor_id = $1 WHERE id = $2';
      const cases: Array<Record<string, string>> = [
        {},
        { 'internpath.anonymize': 'on' },
        { 'internpath.anonymous_actor_id': anonymous },
        { 'internpath.anonymize': 'off', 'internpath.anonymous_actor_id': anonymous },
      ];
      for (const settings of cases) {
        expect(await attempt(sql, [anonymous, historyId], settings), JSON.stringify(settings)).to.match(/append-only/i);
      }
    });

    it('ปฏิเสธ: ค่าใหม่ไม่ตรงกับ anonymous_actor_id, แก้คอลัมน์อื่นร่วมด้วย, หรือแถวเดิมไม่มี actor (SYSTEM)', async () => {
      const { historyId, auditId } = await seedRows();
      expect(await attempt('UPDATE status_history SET actor_id = $1 WHERE id = $2', [randomUUID(), historyId], both)).to.match(/append-only/i);
      expect(
        await attempt("UPDATE status_history SET actor_id = $1, to_status = 'X' WHERE id = $2", [anonymous, historyId], both),
      ).to.match(/append-only/i);
      expect(
        await attempt("UPDATE admin_audit_log SET admin_id = $1, action = 'X' WHERE id = $2", [anonymous, auditId], both),
      ).to.match(/append-only/i);
      const system = await pg.query(
        `INSERT INTO status_history (entity, entity_id, to_status, actor_role, correlation_id)
         VALUES ('QUEUE_ITEM', $1, 'OPEN', 'SYSTEM', $2) RETURNING id`,
        [randomUUID(), randomUUID()],
      );
      expect(await attempt('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, system.rows[0].id], both)).to.match(/append-only/i);
    });

    it('ปฏิเสธ DELETE แม้ตั้ง setting ครบ', async () => {
      await seedRows();
      expect(await attempt('DELETE FROM status_history', [], both)).to.match(/append-only/i);
      expect(await attempt('DELETE FROM admin_audit_log', [], both)).to.match(/append-only/i);
    });
  });

  it('สไลซ์ 3: review_moderations.review_id UNIQUE, review_reports (review_id, reporter_user_id) UNIQUE, queue_items รับ origin REVIEW_SCAN/REVIEW_REPORT และ type REVIEW_HELD/REVIEW_REPORT', async () => {
    const review = randomUUID();
    const insertModeration = () =>
      pg.query(
        `INSERT INTO review_moderations (review_id, company_id, student_user_id, rating, outcome_label, body, decision, reasons, status)
         VALUES ($1, $2, $3, 5, 'PASS', 'ดีมาก', 'PUBLISH', '[]', 'PASSED')`,
        [review, randomUUID(), randomUUID()],
      );
    const messageOf = async (run: () => Promise<unknown>): Promise<string> => {
      try {
        await run();
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    await insertModeration();
    expect(await messageOf(insertModeration)).to.match(/duplicate key/i);

    const reporter = randomUUID();
    const insertReport = () =>
      pg.query('INSERT INTO review_reports (review_id, reporter_user_id, reason) VALUES ($1, $2, $3)', [review, reporter, 'เหตุผลยาวพอ']);
    await insertReport();
    expect(await messageOf(insertReport)).to.match(/duplicate key/i);

    for (const [type, origin] of [
      ['REVIEW_HELD', 'REVIEW_SCAN'],
      ['REVIEW_REPORT', 'REVIEW_REPORT'],
    ]) {
      await pg.query(
        `INSERT INTO queue_items (type, target_type, target_id, origin, due_at)
         VALUES ($1::queue_item_type, 'review', $2, $3::queue_origin, now())`,
        [type, randomUUID(), origin],
      );
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

  it('สไลซ์ 2: job_reports ซ้ำ (job_id, reporter_user_id) ⇒ unique; company_rejection_events.source_event_id ซ้ำ ⇒ unique', async () => {
    const job = randomUUID();
    const user = randomUUID();
    const report = () =>
      pg.query(
        `INSERT INTO job_reports (job_id, reporter_user_id, category, detail, counted, status)
         VALUES ($1, $2, 'OTHER', 'รายละเอียดอย่างน้อยยี่สิบตัวอักษรครบถ้วน', true, 'OPEN')`,
        [job, user],
      );
    await report();
    let err: { code?: string } | undefined;
    try {
      await report();
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).to.equal('23505');

    const evt = randomUUID();
    const rejection = () =>
      pg.query(
        `INSERT INTO company_rejection_events (company_id, job_id, kind, occurred_at, source_event_id)
         VALUES ($1, $2, 'AUTO_REJECTED', now(), $3)`,
        [randomUUID(), randomUUID(), evt],
      );
    await rejection();
    err = undefined;
    try {
      await rejection();
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).to.equal('23505');
  });

  it('สไลซ์ 2: queue_items รับ origin REPORT_THRESHOLD/REPORT_UNCOUNTED/REJECTION_THRESHOLD/ADMIN_FLAG', async () => {
    for (const origin of ['REPORT_THRESHOLD', 'REPORT_UNCOUNTED', 'REJECTION_THRESHOLD', 'ADMIN_FLAG']) {
      await pg.query(
        `INSERT INTO queue_items (type, target_type, target_id, priority, is_appeal, origin, due_at, status)
         VALUES ('JOB_REPORT', 'job', $1, 'NORMAL', false, $2::queue_origin, now(), 'OPEN')`,
        [randomUUID(), origin],
      );
    }
  });
});
