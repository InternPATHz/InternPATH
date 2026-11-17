import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Client } from 'pg';

/**
 * Helper สร้างฐาน lifecycle_db ชั่วคราวต่อรอบเทสต์ (แบบเดียวกับ test/db/schema.spec.ts)
 * ใช้ `LIFECYCLE_IT_ADMIN_URL` หรือ `LIFECYCLE_DIRECT_URL` ใน .env ที่ราก (เปลี่ยน db เป็น postgres)
 * คืน `undefined` เมื่อเชื่อม Postgres ไม่ได้ ⇒ ผู้เรียกควร `this.skip()`
 */

const APP_ROOT = path.resolve(__dirname, '../..');
const ROOT_ENV = path.resolve(APP_ROOT, '../../.env');

export function adminUrl(): string | undefined {
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

export interface TestDatabase {
  url: string;
  drop(): Promise<void>;
}

export async function createTestDatabase(prefix = 'lc_it'): Promise<TestDatabase | undefined> {
  const base = adminUrl();
  if (!base) return undefined;
  const admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
  try {
    await admin.connect();
    await admin.query('SELECT 1');
  } catch {
    await admin.end().catch(() => undefined);
    return undefined;
  }

  const dbName = `${prefix}_${randomBytes(4).toString('hex')}`;
  await admin.query(`CREATE DATABASE ${dbName}`);
  const dbUrl = new URL(base);
  dbUrl.pathname = `/${dbName}`;
  const url = dbUrl.toString();
  const drop = async () => {
    await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
    await admin.end().catch(() => undefined);
  };
  try {
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT,
      env: { ...process.env, LIFECYCLE_DATABASE_URL: url, LIFECYCLE_DIRECT_URL: url },
      stdio: 'pipe',
    });
  } catch (error) {
    await drop();
    const failure = error as { stderr?: Buffer; stdout?: Buffer; message: string };
    throw new Error(
      `Lifecycle migration failed: ${failure.stderr?.toString() || failure.stdout?.toString() || failure.message}`,
      { cause: error },
    );
  }
  return { url, drop };
}
