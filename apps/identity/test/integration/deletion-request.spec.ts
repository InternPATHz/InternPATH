import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { AccountDeletionModule } from '../../src/modules/account-deletion/account-deletion.module';
import { LIFECYCLE_SECRET_ENV, LIFECYCLE_URL_ENV } from '../../src/modules/account-deletion/lifecycle-eligibility.client';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const APP_ROOT = path.resolve(__dirname, '../..');
const ROOT_ENV = path.resolve(APP_ROOT, '../../.env');
function adminUrl(): string | undefined {
  if (process.env.IDENTITY_IT_ADMIN_URL) return process.env.IDENTITY_IT_ADMIN_URL;
  if (!existsSync(ROOT_ENV)) return undefined;
  const line = readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/).find((value) => value.startsWith('IDENTITY_DIRECT_URL='));
  if (!line) return undefined;
  const url = new URL(line.slice('IDENTITY_DIRECT_URL='.length).replace(/^"|"$/g, ''));
  url.pathname = '/postgres';
  return url.toString();
}

@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class StubMessagingModule {}

const SECRET = 'identity-lifecycle-shared-secret-for-tests-0123';

type LifecycleMode = 'eligible' | 'blocked' | 'error' | 'invalid';

/*
 * `POST /users/me/deletion-request` (api-contract §4.2, §9 — PM ตัดสิน 2026-11-17) ผ่าน HTTP + Postgres จริง
 * ใช้ `LifecycleDeletionEligibility` ตัวจริงยิงไปยัง Lifecycle ปลอม (http server ในเทสต์) ที่ตรวจ Service Token จริง
 */
describe('Identity POST /users/me/deletion-request (Postgres + Lifecycle ปลอม)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let privateKey: string;
  let lifecycle: Server;
  let lifecycleUrl: string;
  let mode: LifecycleMode = 'eligible';
  const calls: Array<{ path: string; tokenOk: boolean }> = [];
  const http = () => request(app.getHttpServer());
  const auth = (id: string, role = 'STUDENT') =>
    `Bearer ${jwt.sign({ role }, privateKey, { algorithm: 'RS256', subject: id, jwtid: randomUUID(), expiresIn: 900 })}`;

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_delreq_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base); url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT, env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl }, stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;

    lifecycle = createServer((req, res) => {
      let tokenOk = false;
      try {
        jwt.verify((req.headers.authorization ?? '').replace(/^Bearer /, ''), SECRET,
          { algorithms: ['HS256'], audience: 'lifecycle', issuer: 'identity' });
        tokenOk = true;
      } catch { /* token ไม่ผ่าน */ }
      calls.push({ path: req.url ?? '', tokenOk });
      if (!tokenOk) { res.writeHead(401).end(); return; }
      if (mode === 'error') { res.writeHead(500).end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(mode === 'invalid' ? '{"ok":1}' : JSON.stringify({ eligible: mode === 'eligible', blocking_application_count: mode === 'eligible' ? 0 : 1 }));
    });
    await new Promise<void>((resolve) => lifecycle.listen(0, '127.0.0.1', resolve));
    lifecycleUrl = `http://127.0.0.1:${(lifecycle.address() as AddressInfo).port}`;
    process.env[LIFECYCLE_URL_ENV] = lifecycleUrl;
    process.env[LIFECYCLE_SECRET_ENV] = SECRET;

    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    privateKey = pair.privateKey;
    process.env.JWT_PUBLIC_KEY = pair.publicKey;
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule, StubMessagingModule, AccountDeletionModule] }).compile();
    app = moduleRef.createNestApplication({ logger: false }); configureApp(app); await app.init();
    db = app.get(PrismaService);
  });

  after(async () => {
    await app?.close();
    await new Promise<void>((resolve) => (lifecycle ? lifecycle.close(() => resolve()) : resolve()));
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    for (const key of ['IDENTITY_DATABASE_URL', 'IDENTITY_DIRECT_URL', LIFECYCLE_URL_ENV, LIFECYCLE_SECRET_ENV]) delete process.env[key];
  });

  beforeEach(() => {
    mode = 'eligible';
    calls.length = 0;
    process.env[LIFECYCLE_URL_ENV] = lifecycleUrl;
    process.env[LIFECYCLE_SECRET_ENV] = SECRET;
  });

  const student = () => db.user.create({ data: { email: `s-${randomUUID()}@example.test`, passwordHash: 'hash',
    fullName: 'Student Name', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(),
    refreshTokens: { create: { tokenHash: `r-${randomUUID()}`, familyId: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } } } });
  const deletion = (userId: string, role = 'STUDENT') =>
    http().post('/v1/users/me/deletion-request').set('Authorization', auth(userId, role));

  it('Lifecycle ตอบ eligible ⇒ 204 ไม่มี body • ลบ/ทำให้ไม่ระบุตัวตนในคำขอเดียว • token ถูกเพิกถอน • ส่ง E15', async () => {
    const user = await student();
    const res = await deletion(user.id).set('X-Correlation-Id', randomUUID()).expect(204);
    expect(res.text).to.equal('');
    expect(calls).to.deep.equal([{ path: `/internal/v1/users/${user.id}/deletion-eligibility`, tokenOk: true }]);
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status).to.equal('DELETED');
    expect(await db.tokenDenylist.count({ where: { userId: user.id } })).to.equal(1);
    expect(await db.refreshToken.count({ where: { userId: user.id } })).to.equal(0);
    expect(await db.outboxEvent.count({ where: { aggregateId: user.id, type: 'UserDeletionRequested' } })).to.equal(1);
    expect((await db.deletionRequest.findFirstOrThrow({ where: { userId: user.id } })).status).to.equal('COMPLETED');
  });

  it('มีใบสมัครที่ดำเนินอยู่ ⇒ 422 DELETION_BLOCKED และบัญชีไม่เปลี่ยน', async () => {
    const user = await student();
    mode = 'blocked';
    const res = await deletion(user.id).expect(422);
    expect(res.body.error.code).to.equal('DELETION_BLOCKED');
    expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status).to.equal('ACTIVE');
    expect((await db.deletionRequest.findFirstOrThrow({ where: { userId: user.id } })).status).to.equal('BLOCKED');
    expect(await db.outboxEvent.count({ where: { aggregateId: user.id } })).to.equal(0);
  });

  for (const [name, setup] of [
    ['Lifecycle ตอบ 500', () => { mode = 'error'; }],
    ['Lifecycle ตอบผิดรูป', () => { mode = 'invalid'; }],
    ['Lifecycle ล่ม (ต่อไม่ได้)', () => { process.env[LIFECYCLE_URL_ENV] = 'http://127.0.0.1:1'; }],
    ['ไม่ได้ตั้ง secret', () => { delete process.env[LIFECYCLE_SECRET_ENV]; }],
  ] as const) {
    it(`${name} ⇒ 503 UPSTREAM_UNAVAILABLE (fail-closed) ไม่มีอะไรถูกลบ`, async () => {
      const user = await student();
      setup();
      expect((await deletion(user.id).expect(503)).body.error.code).to.equal('UPSTREAM_UNAVAILABLE');
      expect((await db.user.findUniqueOrThrow({ where: { id: user.id } })).status).to.equal('ACTIVE');
      expect(await db.tokenDenylist.count({ where: { userId: user.id } })).to.equal(0);
      expect(await db.outboxEvent.count({ where: { aggregateId: user.id } })).to.equal(0);
    });
  }

  it('Owner ที่ยังไม่โอน ⇒ 422 DELETION_BLOCKED (ไม่ต้องถาม Lifecycle) • ไม่มี Token ⇒ 401', async () => {
    const owner = await db.user.create({ data: { email: `o-${randomUUID()}@example.test`, passwordHash: 'hash',
      fullName: 'Owner', role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date() } });
    const company = await db.company.create({ data: { name: 'Owner Co', emailDomain: 'owner.example.test', registrationNo: `REG-${randomUUID().slice(0, 8)}`,
      members: { create: { userId: owner.id, memberRole: 'OWNER' } } } });
    expect(company.id).to.be.a('string');
    expect((await deletion(owner.id, 'COMPANY_HR').expect(422)).body.error.code).to.equal('DELETION_BLOCKED');
    expect(calls).to.deep.equal([]);
    await http().post('/v1/users/me/deletion-request').expect(401);
  });

  it('Admin คนสุดท้ายที่ใช้งานได้ลบบัญชีไม่ได้ (409 LAST_ACTIVE_ADMIN) • มี Admin อื่นที่ใช้งานได้ ⇒ ลบได้', async () => {
    const makeAdmin = (status: 'ACTIVE' | 'SUSPENDED', verified = true) => db.user.create({ data: {
      email: `a-${randomUUID()}@example.test`, passwordHash: 'hash', fullName: 'Admin', role: 'PLATFORM_ADMIN', status,
      emailVerifiedAt: verified ? new Date() : null } });
    await db.user.updateMany({ where: { role: 'PLATFORM_ADMIN' }, data: { status: 'SUSPENDED' } });
    const only = await makeAdmin('ACTIVE');
    await makeAdmin('SUSPENDED'); // Admin ที่ถูกระงับ/ยังไม่ยืนยันอีเมลไม่นับ
    await makeAdmin('ACTIVE', false);
    const res = await deletion(only.id, 'PLATFORM_ADMIN').expect(409);
    expect(res.body.error.code).to.equal('LAST_ACTIVE_ADMIN');
    expect((await db.user.findUniqueOrThrow({ where: { id: only.id } })).status).to.equal('ACTIVE');

    const second = await makeAdmin('ACTIVE');
    await deletion(only.id, 'PLATFORM_ADMIN').expect(204);
    expect((await db.user.findUniqueOrThrow({ where: { id: only.id } })).status).to.equal('DELETED');
    expect((await db.user.findUniqueOrThrow({ where: { id: second.id } })).status).to.equal('ACTIVE');
  });
});
