#!/usr/bin/env node
/**
 * สร้าง/รีเซ็ตบัญชี PLATFORM_ADMIN สำหรับเครื่อง dev เท่านั้น (Identity ไม่มีทางสมัคร Admin ผ่าน API)
 *
 *   ADMIN_EMAIL=admin@internpath.local ADMIN_PASSWORD='<อย่างน้อย 12 ตัวอักษร>' node scripts/dev-seed-admin.cjs
 *
 * - ต้องตั้ง ADMIN_PASSWORD เอง (สคริปต์ไม่มีรหัสผ่านเริ่มต้น)
 * - ปฏิเสธการทำงานเมื่อ NODE_ENV=production หรือฐานข้อมูลไม่ใช่เครื่องนี้ (localhost/127.0.0.1/::1)
 * - รันซ้ำได้: ถ้ามีอีเมลนี้แล้วจะตั้ง role/status/รหัสผ่านใหม่
 * - อ่าน IDENTITY_DATABASE_URL จาก environment หรือ .env ที่ราก repo; ต้องรัน `pnpm --filter @internpath/identity prisma:generate` ก่อน
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const identityRequire = createRequire(path.join(root, 'apps/identity/package.json'));

function loadEnvFile() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function fail(message) {
  console.error(`seed-admin: ${message}`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV === 'production') fail('ปฏิเสธเมื่อ NODE_ENV=production');
  loadEnvFile();

  const email = (process.env.ADMIN_EMAIL || 'admin@internpath.local').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (password.length < 12) fail('ต้องตั้ง ADMIN_PASSWORD อย่างน้อย 12 ตัวอักษร');

  const url = process.env.IDENTITY_DATABASE_URL;
  if (!url) fail('ไม่พบ IDENTITY_DATABASE_URL');
  let host;
  try { host = new URL(url).hostname; } catch { fail('IDENTITY_DATABASE_URL อ่านไม่ได้'); }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) fail(`ปฏิเสธ: ฐานข้อมูลอยู่ที่ ${host} ไม่ใช่เครื่องนี้`);

  const argon2 = identityRequire('argon2');
  const { PrismaClient } = identityRequire('./generated/client');
  const db = new PrismaClient({ datasources: { db: { url } } });
  try {
    // พารามิเตอร์ตรงกับ hashPassword ใน apps/identity/src/modules/auth/password-hash.ts
    const passwordHash = await argon2.hash(password, {
      type: argon2.argon2id, version: 0x13, memoryCost: 64 * 1024, timeCost: 3, parallelism: 1, hashLength: 32,
    });
    const data = {
      passwordHash, role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date(),
      failedLoginCount: 0, lockedUntil: null, fullName: 'Platform Admin (dev)', deletedAt: null,
    };
    const user = await db.user.upsert({ where: { email }, create: { email, ...data }, update: data });
    console.log(`seed-admin: พร้อมใช้งาน ${user.email} (role=${user.role}, status=${user.status})`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
