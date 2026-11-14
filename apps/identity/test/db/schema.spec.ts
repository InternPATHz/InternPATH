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
  const override = process.env.IDENTITY_IT_ADMIN_URL;
  if (override) return override;
  if (!existsSync(ROOT_ENV)) return undefined;
  const line = readFileSync(ROOT_ENV, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.startsWith('IDENTITY_DIRECT_URL='));
  if (!line) return undefined;
  const url = new URL(line.slice('IDENTITY_DIRECT_URL='.length).replace(/^"|"$/g, ''));
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

describe('identity_db migration (Postgres จริง)', function () {
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

    dbName = `id_it_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const dbUrl = new URL(base);
    dbUrl.pathname = `/${dbName}`;
    const url = dbUrl.toString();
    testDatabaseUrl = url;
    try {
      execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
        cwd: APP_ROOT,
        env: { ...process.env, IDENTITY_DATABASE_URL: url, IDENTITY_DIRECT_URL: url },
        stdio: 'pipe',
      });
      pg = new Client({ connectionString: url });
      await pg.connect();
    } catch (error) {
      const failure = error as { stderr?: Buffer; stdout?: Buffer; message: string };
      throw new Error(
        `Identity migration failed: ${failure.stderr?.toString() || failure.stdout?.toString() || failure.message}`,
        { cause: error },
      );
    }
  });

  after(async () => {
    await pg?.end().catch(() => undefined);
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
  });

  it('สร้างตาราง Identity ครบ 19 ตารางบนฐานเปล่า', async () => {
    const rows = (
      await pg.query(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = 'public' AND table_name <> '_prisma_migrations' ORDER BY table_name`,
      )
    ).rows.map((row: { table_name: string }) => row.table_name);
    expect(rows).to.deep.equal(
      [
        'admin_audit_log', 'advisor_profiles', 'companies', 'company_documents',
        'company_invitations', 'company_members', 'company_rating_stats', 'consents',
        'deletion_requests', 'email_tokens', 'outbox_events', 'owner_transfers',
        'processed_events', 'refresh_tokens', 'status_history', 'student_profiles_identity',
        'token_denylist', 'universities', 'users',
      ].sort(),
    );
  });

  it('Prisma Client ของ Identity เชื่อมฐานทดสอบและอ่านตารางเฉพาะ Service ได้', async () => {
    const prisma = new PrismaClient({ datasourceUrl: testDatabaseUrl });
    try {
      expect(await prisma.university.count()).to.equal(0);
      expect(await prisma.company.count()).to.equal(0);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('email เป็น citext: ปฏิเสธอีเมลซ้ำแม้ตัวพิมพ์ต่างกัน', async () => {
    await pg.query(
      `INSERT INTO users (email, password_hash, role, full_name)
       VALUES ('Student@Example.ac.th', 'test-hash', 'STUDENT', 'Test Student')`,
    );
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO users (email, password_hash, role, full_name)
           VALUES ('student@example.ac.th', 'test-hash', 'STUDENT', 'Duplicate')`,
        ),
      ),
    ).to.equal('23505');
  });

  it('บริษัทหนึ่งมี OWNER ได้สูงสุดหนึ่งคน', async () => {
    const company = (await pg.query(`INSERT INTO companies (name, registration_no, email_domain)
      VALUES ('Test Co', 'test-reg-no', 'test.co') RETURNING id`)).rows[0].id;
    const users = (
      await pg.query(
        `INSERT INTO users (email, password_hash, role, full_name)
         VALUES ('one@test.co', 'test-hash', 'COMPANY_HR', 'Owner One'),
                ('two@test.co', 'test-hash', 'COMPANY_HR', 'Owner Two') RETURNING id`,
      )
    ).rows.map((row: { id: string }) => row.id);
    await pg.query(
      `INSERT INTO company_members (company_id, user_id, member_role) VALUES ($1, $2, 'OWNER')`,
      [company, users[0]],
    );
    expect(
      await errorCode(() =>
        pg.query(
          `INSERT INTO company_members (company_id, user_id, member_role) VALUES ($1, $2, 'OWNER')`,
          [company, users[1]],
        ),
      ),
    ).to.equal('23505');
    await pg.query(
      `INSERT INTO company_members (company_id, user_id, member_role) VALUES ($1, $2, 'MEMBER')`,
      [company, users[1]],
    );
  });

  it('status_history และ admin_audit_log ปฏิเสธ UPDATE/DELETE', async () => {
    const target = randomUUID();
    const correlation = randomUUID();
    const history = (await pg.query(
      `INSERT INTO status_history (entity, entity_id, to_status, actor_role, correlation_id)
       VALUES ('COMPANY', $1, 'PENDING', 'SYSTEM', $2) RETURNING id`,
      [target, correlation],
    )).rows[0].id;
    const audit = (await pg.query(
      `INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, correlation_id)
       VALUES ($1, 'test', 'COMPANY', $2, $3) RETURNING id`,
      [randomUUID(), target, correlation],
    )).rows[0].id;
    expect(await errorCode(() => pg.query(`UPDATE status_history SET reason = 'x' WHERE id = $1`, [history]))).to.equal('P0001');
    expect(await errorCode(() => pg.query(`DELETE FROM status_history WHERE id = $1`, [history]))).to.equal('P0001');
    expect(await errorCode(() => pg.query(`UPDATE admin_audit_log SET reason = 'x' WHERE id = $1`, [audit]))).to.equal('P0001');
    expect(await errorCode(() => pg.query(`DELETE FROM admin_audit_log WHERE id = $1`, [audit]))).to.equal('P0001');
  });
});
