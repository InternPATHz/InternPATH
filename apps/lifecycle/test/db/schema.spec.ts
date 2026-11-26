import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'chai';
import { Client } from 'pg';
import { PrismaClient } from '../../generated/client';

const APP_ROOT = path.resolve(__dirname, '../..');
const ROOT_ENV = path.resolve(APP_ROOT, '../../.env');

function adminUrl(): string | undefined {
  const override = process.env.LIFECYCLE_IT_ADMIN_URL;
  if (override) return override;
  if (!existsSync(ROOT_ENV)) return undefined;
  const line = readFileSync(ROOT_ENV, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.startsWith('LIFECYCLE_DIRECT_URL='));
  if (!line) return undefined;
  const url = new URL(line.slice('LIFECYCLE_DIRECT_URL='.length).replace(/^"|"$/g, ''));
  url.pathname = '/postgres';
  return url.toString();
}

async function errorCode(run: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await run();
  } catch (error) {
    return (error as { code?: string }).code;
  }
  return undefined;
}

describe('lifecycle_db migration (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let pg: Client;
  let dbName: string;
  let testDatabaseUrl: string;

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try {
      await admin.connect();
      await admin.query('SELECT 1');
    } catch {
      await admin.end().catch(() => undefined);
      this.skip();
    }

    dbName = `lc_it_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const dbUrl = new URL(base);
    dbUrl.pathname = `/${dbName}`;
    const url = dbUrl.toString();
    testDatabaseUrl = url;
    try {
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
        cwd: APP_ROOT,
        env: { ...process.env, LIFECYCLE_DATABASE_URL: url, LIFECYCLE_DIRECT_URL: url },
        stdio: 'pipe',
      });
      pg = new Client({ connectionString: url });
      await pg.connect();
    } catch (error) {
      const failure = error as { stderr?: Buffer; stdout?: Buffer; message: string };
      throw new Error(
        `Lifecycle migration failed: ${failure.stderr?.toString() || failure.stdout?.toString() || failure.message}`,
        { cause: error },
      );
    }
  });

  after(async () => {
    await pg?.end().catch(() => undefined);
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
  });

  it('สร้างตาราง Lifecycle ครบ 21 ตารางบนฐานเปล่า (รวม conduct_reports — 2026-11-26)', async () => {
    const rows = (
      await pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
      )
    ).rows.map((row: { table_name: string }) => row.table_name);
    expect(rows).to.deep.equal(
      [
        'admin_audit_log',
        'applications',
        'certificates',
        'company_review_stats',
        'company_snapshots',
        'conduct_reports',
        'config_overrides',
        'evaluations',
        'fail_disputes',
        'job_snapshots',
        'outbox_events',
        'problem_reports',
        'processed_events',
        'reapply_unlocks',
        'reminder_log',
        'resumes',
        'review_replies',
        'reviews',
        'status_history',
        'student_advisor_links',
        'student_profiles',
      ].sort(),
    );
  });

  it('Prisma Client ของ Lifecycle เชื่อมฐานทดสอบและอ่านตารางเฉพาะ Service ได้', async () => {
    const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    try {
      expect(await prisma.studentProfile.count()).to.equal(0);
      expect(await prisma.application.count()).to.equal(0);
      expect(await prisma.certificate.count()).to.equal(0);
      expect(await prisma.review.count()).to.equal(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('partial unique index 1: ยืนยันได้ทีละ 1 ที่ (ห้ามมี 2 ใบสมัครในสถานะกำลังยืนยัน)', async () => {
    const studentId = randomUUID();
    const company1 = randomUUID();
    const company2 = randomUUID();
    const job1 = randomUUID();
    const job2 = randomUUID();

    await pg.query(
      `INSERT INTO applications (job_id, company_id, student_user_id, status)
       VALUES ($1, $2, $3, 'ADVISOR_PENDING')`,
      [job1, company1, studentId],
    );

    // ยืนยันอีกใบขณะใบแรกยังค้างอยู่ใน ADVISOR_PENDING -> ต้องติด 23505 (unique_violation)
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO applications (job_id, company_id, student_user_id, status)
           VALUES ($1, $2, $3, 'IN_PROGRESS')`,
          [job2, company2, studentId],
        ),
      ),
    ).to.equal('23505');
  });

  it('partial unique index 2: ห้ามสมัครซ้ำประกาศเดิมที่ยังดำเนินอยู่', async () => {
    const studentId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();

    await pg.query(
      `INSERT INTO applications (job_id, company_id, student_user_id, status)
       VALUES ($1, $2, $3, 'PENDING')`,
      [jobId, companyId, studentId],
    );

    // สมัครซ้ำงานเดิมขณะยัง PENDING -> ต้องติด 23505
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO applications (job_id, company_id, student_user_id, status)
           VALUES ($1, $2, $3, 'PENDING')`,
          [jobId, companyId, studentId],
        ),
      ),
    ).to.equal('23505');
  });

  it('CHECK constraint: certificates ปฏิเสธ actual_days < 30', async () => {
    const studentId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    const certCode = 'IP-2026-TEST01';

    const appId = (
      await pg.query(
        `INSERT INTO applications (job_id, company_id, student_user_id, status)
         VALUES ($1, $2, $3, 'COMPLETED') RETURNING id`,
        [jobId, companyId, studentId],
      )
    ).rows[0].id;

    // actual_days = 29 -> ต้องติด 23514 (check_violation)
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO certificates (
             certificate_code, application_id, student_user_id, company_id,
             holder_name_snapshot, company_name_snapshot, job_title_snapshot,
             period_start, period_end, actual_days, pdf_object_key, pdf_sha256,
             issued_by
           ) VALUES ($1, $2, $3, $4, 'Test Student', 'Test Corp', 'Dev Intern',
                     '2026-06-01', '2026-06-29', 29, 'test-key', 'hash123', $5)`,
          [certCode, appId, studentId, companyId, randomUUID()],
        ),
      ),
    ).to.equal('23514');
  });

  it('CHECK constraint: evaluations ปฏิเสธ round ที่ไม่ใช่ 1 หรือ 2', async () => {
    const studentId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    const appId = (
      await pg.query(
        `INSERT INTO applications (job_id, company_id, student_user_id, status)
         VALUES ($1, $2, $3, 'IN_PROGRESS') RETURNING id`,
        [jobId, companyId, studentId],
      )
    ).rows[0].id;

    // round = 3 -> ต้องติด 23514
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO evaluations (application_id, round, result, evaluated_by)
           VALUES ($1, 3, 'PASS', $2)`,
          [appId, randomUUID()],
        ),
      ),
    ).to.equal('23514');
  });

  it('CHECK constraint: evaluations บังคับ reason เมื่อ result = FAIL', async () => {
    const studentId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    const appId = (
      await pg.query(
        `INSERT INTO applications (job_id, company_id, student_user_id, status)
         VALUES ($1, $2, $3, 'IN_PROGRESS') RETURNING id`,
        [jobId, companyId, studentId],
      )
    ).rows[0].id;

    // FAIL แต่ไม่มี reason -> ต้องติด 23514
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO evaluations (application_id, round, result, evaluated_by)
           VALUES ($1, 1, 'FAIL', $2)`,
          [appId, randomUUID()],
        ),
      ),
    ).to.equal('23514');

    // FAIL พร้อม reason -> ผ่าน
    await pg.query(
      `INSERT INTO evaluations (application_id, round, result, reason, evaluated_by)
       VALUES ($1, 1, 'FAIL', 'ประสิทธิภาพไม่ผ่านเกณฑ์', $2)`,
      [appId, randomUUID()],
    );
  });

  it('CHECK constraint: reviews ปฏิเสธ rating นอกช่วง 1-5', async () => {
    const studentId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    const appId = (
      await pg.query(
        `INSERT INTO applications (job_id, company_id, student_user_id, status)
         VALUES ($1, $2, $3, 'COMPLETED') RETURNING id`,
        [jobId, companyId, studentId],
      )
    ).rows[0].id;

    // rating = 6 -> ต้องติด 23514
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO reviews (application_id, company_id, student_user_id, rating, body, outcome_label)
           VALUES ($1, $2, $3, 6, 'Great company', 'PASS')`,
          [appId, companyId, studentId],
        ),
      ),
    ).to.equal('23514');

    // rating = 0 -> ต้องติด 23514
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO reviews (application_id, company_id, student_user_id, rating, body, outcome_label)
           VALUES ($1, $2, $3, 0, 'Terrible', 'FAIL')`,
          [appId, companyId, studentId],
        ),
      ),
    ).to.equal('23514');
  });

  it('FK ON DELETE RESTRICT: certificates และ reviews ป้องกันการลบ applications', async () => {
    const studentId = randomUUID();
    const companyId = randomUUID();
    const jobId = randomUUID();
    const certCode = 'IP-2026-RESTRICT-01';

    const appId = (
      await pg.query(
        `INSERT INTO applications (job_id, company_id, student_user_id, status)
         VALUES ($1, $2, $3, 'COMPLETED') RETURNING id`,
        [jobId, companyId, studentId],
      )
    ).rows[0].id;

    await pg.query(
      `INSERT INTO certificates (
         certificate_code, application_id, student_user_id, company_id,
         holder_name_snapshot, company_name_snapshot, job_title_snapshot,
         period_start, period_end, actual_days, pdf_object_key, pdf_sha256,
         issued_by
       ) VALUES ($1, $2, $3, $4, 'Test Student', 'Test Corp', 'Dev Intern',
                 '2026-06-01', '2026-07-15', 45, 'key-cert', 'hash-cert', $5)`,
      [certCode, appId, studentId, companyId, randomUUID()],
    );

    // พยายาม DELETE applications ที่มี certificate ผูกอยู่ -> ต้องติด 23503 (foreign_key_violation) เพราะเป็น ON DELETE RESTRICT
    expect(
      await errorCode(() => pg.query(`DELETE FROM applications WHERE id = $1`, [appId])),
    ).to.equal('23503');
  });

  it('status_history และ admin_audit_log ปฏิเสธ UPDATE/DELETE ทั่วไป (append-only trigger)', async () => {
    const target = randomUUID();
    const correlation = randomUUID();
    const history = (
      await pg.query(
        `INSERT INTO status_history (entity, entity_id, to_status, actor_role, correlation_id)
         VALUES ('APPLICATION', $1, 'PENDING', 'SYSTEM', $2) RETURNING id`,
        [target, correlation],
      )
    ).rows[0].id;

    const audit = (
      await pg.query(
        `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, correlation_id)
         VALUES ($1, 'test', 'APPLICATION', $2, $3) RETURNING id`,
        [randomUUID(), target, correlation],
      )
    ).rows[0].id;

    expect(await errorCode(() => pg.query(`UPDATE status_history SET reason = 'x' WHERE id = $1`, [history]))).to.equal('P0001');
    expect(await errorCode(() => pg.query(`DELETE FROM status_history WHERE id = $1`, [history]))).to.equal('P0001');
    expect(await errorCode(() => pg.query(`UPDATE admin_audit_log SET reason = 'x' WHERE id = $1`, [audit]))).to.equal('P0001');
    expect(await errorCode(() => pg.query(`DELETE FROM admin_audit_log WHERE id = $1`, [audit]))).to.equal('P0001');
  });

  describe('Authorized Anonymization Operation บน status_history และ admin_audit_log (data-schema §2.3)', () => {
    const anonymous = randomUUID();
    const oldActor = randomUUID();
    const otherActor = randomUUID();
    const correlation = randomUUID();
    const target = randomUUID();

    const seedRows = async () => {
      const historyId = (
        await pg.query(
          `INSERT INTO status_history (entity, entity_id, to_status, actor_id, actor_role, reason, correlation_id)
           VALUES ('APPLICATION', $1, 'PENDING', $2, 'STUDENT', 'original', $3) RETURNING id`,
          [target, oldActor, correlation],
        )
      ).rows[0].id;

      const auditId = (
        await pg.query(
          `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, reason, correlation_id)
           VALUES ($1, 'DELETE_USER', 'USER', $2, 'original', $3) RETURNING id`,
          [oldActor, target, correlation],
        )
      ).rows[0].id;

      return { historyId, auditId };
    };

    const attempt = async (
      sql: string,
      params: any[],
      settings: Record<string, string> = {},
    ): Promise<string> => {
      await pg.query('BEGIN');
      try {
        for (const [name, value] of Object.entries(settings)) {
          await pg.query('SELECT set_config($1, $2, true)', [name, value]);
        }
        await pg.query(sql, params);
        return '';
      } catch (e) {
        return (e as Error).message;
      } finally {
        await pg.query('ROLLBACK');
      }
    };

    const both = {
      'internpath.anonymize': 'on',
      'internpath.anonymous_actor_id': anonymous,
    };

    it('ผ่านเมื่อตั้งค่าครบและเปลี่ยนเฉพาะ actor_id / admin_id เป็น anonymous_actor_id', async () => {
      const { historyId, auditId } = await seedRows();
      expect(await attempt('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, historyId], both)).to.equal('');
      expect(await attempt('UPDATE admin_audit_log SET admin_id = $1 WHERE id = $2', [anonymous, auditId], both)).to.equal('');

      // ทดสอบ COMMIT จริง และค่าเปลี่ยนจริง และ setting ไม่ค้าง
      await pg.query('BEGIN');
      try {
        for (const [n, v] of Object.entries(both)) await pg.query('SELECT set_config($1, $2, true)', [n, v]);
        await pg.query('UPDATE status_history SET actor_id = $1 WHERE id = $2', [anonymous, historyId]);
        await pg.query('UPDATE admin_audit_log SET admin_id = $1 WHERE id = $2', [anonymous, auditId]);
        await pg.query('COMMIT');
      } catch (e) {
        await pg.query('ROLLBACK');
        throw e;
      }

      const historyRow = (await pg.query('SELECT actor_id, reason FROM status_history WHERE id = $1', [historyId])).rows[0];
      const auditRow = (await pg.query('SELECT admin_id, reason FROM admin_audit_log WHERE id = $1', [auditId])).rows[0];
      expect(historyRow).to.include({ actor_id: anonymous, reason: 'original' });
      expect(auditRow).to.include({ admin_id: anonymous, reason: 'original' });
    });

    it('ปฏิเสธเมื่อไม่ตั้งค่า (ไม่มี setting หรือมีไม่ครบ หรือ anonymize ไม่ใช่ on)', async () => {
      const { historyId, auditId } = await seedRows();
      const updateHistory = 'UPDATE status_history SET actor_id = $1 WHERE id = $2';
      const updateAudit = 'UPDATE admin_audit_log SET admin_id = $1 WHERE id = $2';

      expect(await errorCode(() => pg.query(updateHistory, [anonymous, historyId]))).to.equal('P0001');
      expect(await errorCode(() => pg.query(updateAudit, [anonymous, auditId]))).to.equal('P0001');

      const cases: Array<Record<string, string>> = [
        {},
        { 'internpath.anonymize': 'on' },
        { 'internpath.anonymous_actor_id': anonymous },
        { 'internpath.anonymize': 'off', 'internpath.anonymous_actor_id': anonymous },
      ];
      for (const settings of cases) {
        expect(await attempt(updateHistory, [anonymous, historyId], settings), JSON.stringify(settings)).to.match(/append-only/i);
        expect(await attempt(updateAudit, [anonymous, auditId], settings), JSON.stringify(settings)).to.match(/append-only/i);
      }
    });

    it('ปฏิเสธเมื่อค่าไม่ตรงกับ anonymous_actor_id', async () => {
      const { historyId, auditId } = await seedRows();
      expect(
        await attempt('UPDATE status_history SET actor_id = $1 WHERE id = $2', [otherActor, historyId], both),
      ).to.match(/append-only/i);
      expect(
        await attempt('UPDATE admin_audit_log SET admin_id = $1 WHERE id = $2', [otherActor, auditId], both),
      ).to.match(/append-only/i);
    });

    it('ปฏิเสธเมื่อแก้คอลัมน์อื่นร่วมด้วย', async () => {
      const { historyId, auditId } = await seedRows();
      expect(
        await attempt("UPDATE status_history SET actor_id = $1, reason = 'changed' WHERE id = $2", [anonymous, historyId], both),
      ).to.match(/append-only/i);
      expect(
        await attempt("UPDATE admin_audit_log SET admin_id = $1, reason = 'changed' WHERE id = $2", [anonymous, auditId], both),
      ).to.match(/append-only/i);
    });

    it('ปฏิเสธ DELETE เสมอแม้จะตั้งค่า anonymize', async () => {
      const { historyId, auditId } = await seedRows();
      expect(
        await attempt('DELETE FROM status_history WHERE id = $1', [historyId], both),
      ).to.match(/append-only/i);
      expect(
        await attempt('DELETE FROM admin_audit_log WHERE id = $1', [auditId], both),
      ).to.match(/append-only/i);
    });
  });
});
