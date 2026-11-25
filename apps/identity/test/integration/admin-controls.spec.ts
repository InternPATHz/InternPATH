import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import { Client } from 'pg';
import request from 'supertest';
import { AdminModule } from '../../src/modules/admin/admin.module';
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

describe('Identity Admin controls (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let adminId: string;
  let companyId: string;
  let memberId: string;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const bearer = (sub: string, role: string) => {
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub, role, jti: randomUUID(),
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 })}`;
    return `Bearer ${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  };

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_ac_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base);
    url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT, env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl }, stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;
    process.env.JWT_PUBLIC_KEY = publicKey;
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule, StubMessagingModule, AdminModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    adminId = (await db.user.create({ data: { email: 'admin@test.local', passwordHash: 'test', fullName: 'Admin',
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() } })).id;
    const company = await db.company.create({ data: { name: 'Test Company', registrationNo: 'REG-001', emailDomain: 'company.test',
      status: 'VERIFIED' } });
    companyId = company.id;
    memberId = (await db.user.create({ data: { email: 'member@company.test', passwordHash: 'test', fullName: 'Member',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(),
      companyMember: { create: { companyId, memberRole: 'OWNER' } } } })).id;
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    delete process.env.IDENTITY_DATABASE_URL;
    delete process.env.IDENTITY_DIRECT_URL;
    delete process.env.JWT_PUBLIC_KEY;
  });

  it('lists filtered users for Admin without exposing password hashes', async () => {
    await request(app.getHttpServer()).get('/v1/admin/users')
      .set('Authorization', bearer(memberId, 'COMPANY_HR')).expect(403);
    const result = await request(app.getHttpServer()).get('/v1/admin/users?role=COMPANY_HR&q=member&page_size=10')
      .set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).expect(200);
    expect(result.body.meta.total).to.equal(1);
    expect(result.body.data[0]).to.include({ id: memberId, email: 'member@company.test', role: 'COMPANY_HR' });
    expect(result.body.data[0]).to.not.have.property('passwordHash');
    await request(app.getHttpServer()).get('/v1/admin/users?role=unknown')
      .set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).expect(400);
  });

  it('treats % and _ in the user search as plain characters, not LIKE wildcards', async () => {
    const auth = bearer(adminId, 'PLATFORM_ADMIN');
    const underscored = await db.user.create({ data: { email: 'under_score@company.test', passwordHash: 'test', fullName: 'Under Score',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date() } });
    for (const q of ['%', '_', '%%', '\\']) {
      const res = await request(app.getHttpServer()).get(`/v1/admin/users?q=${encodeURIComponent(q)}`).set('Authorization', auth).expect(200);
      expect(res.body.data.map((row: { id: string }) => row.id), `q=${q}`).to.not.include(adminId);
    }
    const literal = await request(app.getHttpServer()).get('/v1/admin/users?q=under_score').set('Authorization', auth).expect(200);
    expect(literal.body.data.map((row: { id: string }) => row.id)).to.deep.equal([underscored.id]);
  });

  it('lists universities and filters users by university with its name', async () => {
    const alpha = await db.university.create({ data: { name: 'Alpha University', emailDomain: 'alpha.ac.th' } });
    const beta = await db.university.create({ data: { name: 'Beta University', emailDomain: 'beta.ac.th', active: false } });
    const make = (email: string, universityId: string) => db.user.create({ data: { email, passwordHash: 'test', fullName: email,
      role: 'ADVISOR', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId } });
    const alphaAdvisor = await make('a1@alpha.ac.th', alpha.id);
    await make('b1@beta.ac.th', beta.id);
    const auth = bearer(adminId, 'PLATFORM_ADMIN');

    await request(app.getHttpServer()).get('/v1/admin/universities').set('Authorization', bearer(memberId, 'COMPANY_HR')).expect(403);
    const list = await request(app.getHttpServer()).get('/v1/admin/universities').set('Authorization', auth).expect(200);
    expect(list.body.data).to.deep.equal([
      { id: alpha.id, name: 'Alpha University', email_domain: 'alpha.ac.th', abbreviation: null, active: true },
      { id: beta.id, name: 'Beta University', email_domain: 'beta.ac.th', abbreviation: null, active: false },
    ]);

    const filtered = await request(app.getHttpServer()).get(`/v1/admin/users?role=ADVISOR&university_id=${alpha.id}`)
      .set('Authorization', auth).expect(200);
    expect(filtered.body.meta.total).to.equal(1);
    expect(filtered.body.data[0]).to.include({ id: alphaAdvisor.id, university_id: alpha.id, university_name: 'Alpha University' });
    const hr = await request(app.getHttpServer()).get('/v1/admin/users?role=COMPANY_HR').set('Authorization', auth).expect(200);
    expect(hr.body.data[0]).to.include({ university_id: null, university_name: null });
    await request(app.getHttpServer()).get('/v1/admin/users?university_id=not-a-uuid').set('Authorization', auth).expect(400);
  });

  it('sets University Partner with E05 snapshot and one audit row; repeated PUT is a no-op', async () => {
    const adminToken = bearer(adminId, 'PLATFORM_ADMIN');
    const url = `/v1/admin/companies/${companyId}/university-partner`;
    await request(app.getHttpServer()).put(url).set('Authorization', bearer(memberId, 'COMPANY_HR')).send({ enabled: true }).expect(403);
    await request(app.getHttpServer()).put(url).set('Authorization', adminToken).send({ enabled: 'yes' }).expect(400);
    const header = { 'X-Correlation-Id': randomUUID() };
    const first = await request(app.getHttpServer()).put(url).set('Authorization', adminToken).set(header).send({ enabled: true }).expect(200);
    expect(first.body).to.deep.equal({ enabled: true });
    await request(app.getHttpServer()).put(url).set('Authorization', adminToken).send({ enabled: true }).expect(200);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: companyId, type: 'CompanyStatusChanged' } });
    expect(event.correlationId).to.equal(header['X-Correlation-Id']);
    expect((event.payload as { snapshot: { university_partner: boolean } }).snapshot.university_partner).to.equal(true);
    expect((event.payload as { entity_version: number }).entity_version).to.equal(2);
    expect(await db.outboxEvent.count({ where: { aggregateId: companyId, type: 'CompanyStatusChanged' } })).to.equal(1);
    expect(await db.adminAuditLog.count({ where: { action: 'COMPANY_UNIVERSITY_PARTNER' } })).to.equal(1);
  });

  it('publishes one ordered E06 per successful entitlement update', async () => {
    const token = bearer(adminId, 'PLATFORM_ADMIN');
    const url = `/v1/admin/companies/${companyId}/entitlements`;
    const values = [{ featured_enabled: true, fast_track_enabled: false }, { featured_enabled: false, fast_track_enabled: true }];
    const results = await Promise.all(values.map((body) => request(app.getHttpServer()).put(url).set('Authorization', token).send(body)));
    expect(results.some((item) => item.status === 200)).to.equal(true);
    expect(results.every((item) => item.status === 200 || item.status === 409)).to.equal(true);
    const successful = results.filter((item) => item.status === 200).length;
    const events = await db.outboxEvent.findMany({ where: { aggregateId: companyId, type: 'CompanyEntitlementChanged' }, orderBy: { createdAt: 'asc' } });
    expect(events).to.have.length(successful);
    expect(events.map((event) => (event.payload as { entity_version: number }).entity_version)).to.deep.equal(
      Array.from({ length: successful }, (_, index) => index + 3),
    );
    const current = await db.company.findUniqueOrThrow({ where: { id: companyId } });
    expect(events[events.length - 1].payload).to.include({ featured_enabled: current.featuredEnabled, fast_track_enabled: current.fastTrackEnabled });
    expect(await db.adminAuditLog.count({ where: { action: 'COMPANY_ENTITLEMENTS' } })).to.equal(successful);
  });

  it('suspends and restores a user with denylist, history, E16 and audit', async () => {
    const token = bearer(adminId, 'PLATFORM_ADMIN');
    const url = `/v1/admin/users/${memberId}/actions`;
    await request(app.getHttpServer()).post(`${url}/suspend`).set('Authorization', token).send({}).expect(400);
    await request(app.getHttpServer()).post(`${url}/suspend`).set('Authorization', token).send({ reason: 'Policy violation' }).expect(204);
    await request(app.getHttpServer()).post(`${url}/suspend`).set('Authorization', token).send({ reason: 'Duplicate' }).expect(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: memberId } })).status).to.equal('SUSPENDED');
    expect(await db.tokenDenylist.count({ where: { userId: memberId } })).to.equal(1);
    await request(app.getHttpServer()).post(`${url}/unsuspend`).set('Authorization', token).send({}).expect(204);
    expect(await db.tokenDenylist.count({ where: { userId: memberId } })).to.equal(0);
    expect(await db.statusHistory.count({ where: { entity: 'USER', entityId: memberId } })).to.equal(2);
    const events = await db.outboxEvent.findMany({ where: { aggregateId: memberId, type: 'UserSuspended' }, orderBy: { createdAt: 'asc' } });
    expect(events.map((event) => (event.payload as { suspended: boolean }).suspended)).to.deep.equal([true, false]);
    expect(await db.adminAuditLog.count({ where: { targetId: memberId } })).to.equal(2);
  });

  it('returns filtered paged audit entries only to Admin', async () => {
    const url = '/v1/admin/audit-logs?action=USER_SUSPEND&page=1&page_size=1';
    await request(app.getHttpServer()).get(url).set('Authorization', bearer(memberId, 'COMPANY_HR')).expect(403);
    const result = await request(app.getHttpServer()).get(url).set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).expect(200);
    expect(result.body.meta).to.deep.equal({ page: 1, page_size: 1, total: 1 });
    expect(result.body.data[0]).to.include({ action: 'USER_SUSPEND', target_id: memberId, admin_id: adminId });
  });

  it('does not unsuspend an HR account while its company is suspended', async () => {
    const token = bearer(adminId, 'PLATFORM_ADMIN');
    await db.company.update({ where: { id: companyId }, data: { status: 'SUSPENDED' } });
    await db.user.update({ where: { id: memberId }, data: { status: 'SUSPENDED', suspendedReason: `COMPANY_SUSPENDED:${companyId}` } });
    await request(app.getHttpServer()).post(`/v1/admin/users/${memberId}/actions/unsuspend`).set('Authorization', token).send({}).expect(409);
    expect((await db.user.findUniqueOrThrow({ where: { id: memberId } })).status).to.equal('SUSPENDED');
  });

  it('audit log filters by a readable code and labels target/admin instead of UUIDs', async () => {
    const auth = bearer(adminId, 'PLATFORM_ADMIN');
    await request(app.getHttpServer()).put(`/v1/admin/companies/${companyId}/university-partner`).set('Authorization', auth).send({ enabled: false });
    const byRegNo = await request(app.getHttpServer()).get('/v1/admin/audit-logs?target_code=REG-001').set('Authorization', auth).expect(200);
    expect(byRegNo.body.meta.total).to.be.greaterThan(0);
    for (const row of byRegNo.body.data) {
      expect(row.target_id).to.equal(companyId);
      expect(row).to.include({ target_label: 'Test Company (REG-001)', admin_label: 'Admin (admin@test.local)' });
    }
    const none = await request(app.getHttpServer()).get('/v1/admin/audit-logs?target_code=NO-SUCH-CODE').set('Authorization', auth).expect(200);
    expect(none.body).to.deep.include({ data: [] });
    expect(none.body.meta.total).to.equal(0);
  });

  it('refuses to let an Admin suspend their own account', async () => {
    const res = await request(app.getHttpServer()).post(`/v1/admin/users/${adminId}/actions/suspend`)
      .set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).send({ reason: 'ทดสอบ' }).expect(409);
    expect(res.body.error.code).to.equal('CANNOT_ACT_ON_SELF');
    const admin = await db.user.findUniqueOrThrow({ where: { id: adminId } });
    expect(admin.status).to.equal('ACTIVE');
    expect(await db.tokenDenylist.count({ where: { userId: adminId } })).to.equal(0);
  });
});
