import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { Client } from 'pg';

/** ค่าเริ่มต้นตรงกับ .env.example (Postgres จาก `pnpm infra:up`); override ด้วย VERIFICATION_IT_ADMIN_URL */
const adminUrl = (): string =>
  process.env.VERIFICATION_IT_ADMIN_URL ?? 'postgresql://internpath:change-me@127.0.0.1:5432/postgres';

const APP_ROOT = path.resolve(__dirname, '../..');

export interface TestDatabase {
  url: string;
  prisma: PrismaClient;
  drop(): Promise<void>;
}

/** เรียกใน `before(function () {...})` — ข้ามทั้ง suite เมื่อต่อ Postgres ไม่ได้ */
export async function dbReachableOrSkip(ctx: Mocha.Context): Promise<void> {
  const client = new Client({ connectionString: adminUrl(), connectionTimeoutMillis: 2000 });
  client.on('error', () => undefined);
  try {
    await client.connect();
    await client.query('SELECT 1');
  } catch {
    ctx.skip();
  } finally {
    await client.end().catch(() => undefined);
  }
}

/** สร้างฐานข้อมูลใหม่ `ver_it_<hex>` แล้วรัน `prisma migrate deploy` (รวม seed) พร้อม PrismaClient ที่ชี้ไปที่ฐานนั้น */
export async function createTestDatabase(): Promise<TestDatabase> {
  const name = `ver_it_${randomBytes(4).toString('hex')}`;
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`CREATE DATABASE ${name}`);
  } finally {
    await admin.end();
  }

  const u = new URL(adminUrl());
  u.pathname = `/${name}`;
  const url = u.toString();

  const prismaCli = require.resolve('prisma/build/index.js');
  try {
    execFileSync(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      cwd: APP_ROOT,
      env: { ...process.env, VERIFICATION_DATABASE_URL: url, VERIFICATION_DIRECT_URL: url },
      stdio: 'pipe',
    });
  } catch (e) {
    await dropDatabase(name);
    const err = e as { stdout?: Buffer; stderr?: Buffer; message: string };
    throw new Error(`prisma migrate deploy failed: ${err.stderr?.toString() || err.stdout?.toString() || err.message}`, {
      cause: e,
    });
  }

  let prisma: PrismaClient;
  try {
    prisma = new PrismaClient({ datasourceUrl: url });
  } catch (e) {
    await dropDatabase(name); // ไม่ทิ้งฐานข้อมูลค้างเมื่อสร้าง client ไม่สำเร็จ (เช่นยังไม่ได้ prisma generate)
    throw e;
  }
  return {
    url,
    prisma,
    drop: async () => {
      await prisma.$disconnect().catch(() => undefined);
      await dropDatabase(name);
    },
  };
}

async function dropDatabase(name: string): Promise<void> {
  const admin = new Client({ connectionString: adminUrl() });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await admin.end();
  }
}
