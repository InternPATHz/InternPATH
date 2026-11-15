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
import { CompaniesModule } from '../../src/modules/companies/companies.module';
import { CompanyStorageService } from '../../src/modules/companies/company-storage.service';
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

describe('Identity company onboarding (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let adminId: string;
  const storage = { upload: async () => `companies/${randomUUID()}/file.pdf`, publicUrl: (key: string) => `https://public.test/${key}`,
    signedUrl: async (key: string) => `https://private.test/${key}?expires=600` };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const bearer = (sub: string, role: string, companyId?: string, companyRole?: string) => {
    const encoded = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const unsigned = `${encoded({ alg: 'RS256', typ: 'JWT' })}.${encoded({ sub, role, company_id: companyId, company_role: companyRole,
      jti: randomUUID(), iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 900 })}`;
    return `Bearer ${unsigned}.${sign('RSA-SHA256', Buffer.from(unsigned), privateKey).toString('base64url')}`;
  };
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_co_${randomBytes(4).toString('hex')}`;
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
      PrismaModule, StubMessagingModule, CompaniesModule] }).overrideProvider(CompanyStorageService).useValue(storage).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    adminId = (await db.user.create({ data: { email: 'admin@test.local', passwordHash: 'test', fullName: 'Admin',
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() } })).id;
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    delete process.env.IDENTITY_DATABASE_URL;
    delete process.env.IDENTITY_DIRECT_URL;
    delete process.env.JWT_PUBLIC_KEY;
  });

  async function fixture() {
    const suffix = randomBytes(4).toString('hex');
    const company = await db.company.create({ data: { name: `Company ${suffix}`, registrationNo: `REG-${suffix}`, emailDomain: 'company.test', website: 'https://company.test' } });
    const owner = await db.user.create({ data: { email: `owner-${suffix}@company.test`, passwordHash: 'test', fullName: 'Owner',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(), companyMember: { create: { companyId: company.id, memberRole: 'OWNER' } } } });
    const member = await db.user.create({ data: { email: `member-${suffix}@company.test`, passwordHash: 'test', fullName: 'Member',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(), companyMember: { create: { companyId: company.id, memberRole: 'MEMBER' } } } });
    return { company, owner, member, ownerToken: bearer(owner.id, 'COMPANY_HR', company.id, 'OWNER'),
      memberToken: bearer(member.id, 'COMPANY_HR', company.id, 'MEMBER'), adminToken: bearer(adminId, 'PLATFORM_ADMIN') };
  }

  it('requires a registration certificate before Admin verifies the company', async () => {
    const { company, ownerToken, adminToken } = await fixture();
    await request(app.getHttpServer()).post(`/v1/admin/companies/${company.id}/actions/verify`).set('Authorization', adminToken).send({}).expect(422);
    await request(app.getHttpServer()).post('/v1/companies/me/documents').set('Authorization', ownerToken)
      .field('doc_type', 'REGISTRATION_CERT').attach('file', Buffer.from('not pdf'), 'fake.pdf').expect(422);
    await request(app.getHttpServer()).post('/v1/companies/me/documents').set('Authorization', ownerToken)
      .field('doc_type', 'REGISTRATION_CERT').attach('file', pdf, 'registration.pdf').expect(201);
    const docs = await request(app.getHttpServer()).get('/v1/companies/me/documents').set('Authorization', ownerToken).expect(200);
    expect(docs.body[0].url).to.include('private.test');
    const queue = await request(app.getHttpServer()).get('/v1/admin/companies?status=PENDING').set('Authorization', adminToken).expect(200);
    expect(queue.body.data.map((item: { id: string }) => item.id)).to.include(company.id);
    const detail = await request(app.getHttpServer()).get(`/v1/admin/companies/${company.id}`).set('Authorization', adminToken).expect(200);
    expect(detail.body.documents[0].url).to.include('private.test');
    expect(detail.body.members).to.have.length(2);
    await request(app.getHttpServer()).post(`/v1/admin/companies/${company.id}/actions/verify`).set('Authorization', adminToken).send({}).expect(204);
    const current = await db.company.findUniqueOrThrow({ where: { id: company.id } });
    expect(current.status).to.equal('VERIFIED');
    expect(await db.statusHistory.count({ where: { entity: 'COMPANY', entityId: company.id } })).to.equal(1);
    expect(await db.adminAuditLog.count({ where: { targetId: company.id } })).to.equal(1);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: company.id } });
    expect(event.type).to.equal('CompanyStatusChanged');
    expect(event.payload).to.include({ company_id: company.id, status: 'VERIFIED', entity_version: 2 });
  });

  it('restricts edits to Owner and emits a new snapshot after name change', async () => {
    const { company, ownerToken, memberToken } = await fixture();
    await request(app.getHttpServer()).patch('/v1/companies/me').set('Authorization', memberToken).send({ name: 'Wrong' }).expect(403);
    const result = await request(app.getHttpServer()).patch('/v1/companies/me').set('Authorization', ownerToken).send({ name: 'Updated Company' }).expect(200);
    expect(result.body.name).to.equal('Updated Company');
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: company.id } });
    expect((event.payload as { snapshot: { name: string } }).snapshot.name).to.equal('Updated Company');
  });

  it('validates logo content and publishes its object key in the company snapshot', async () => {
    const { company, ownerToken, memberToken } = await fixture();
    const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
    await request(app.getHttpServer()).post('/v1/companies/me/logo').set('Authorization', memberToken)
      .attach('file', png, 'logo.png').expect(403);
    await request(app.getHttpServer()).post('/v1/companies/me/logo').set('Authorization', ownerToken)
      .attach('file', Buffer.from('bad'), 'logo.png').expect(422);
    const result = await request(app.getHttpServer()).post('/v1/companies/me/logo').set('Authorization', ownerToken)
      .attach('file', png, 'logo.png').expect(201);
    expect(result.body.logo_url).to.include('public.test');
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: company.id } });
    expect((event.payload as { snapshot: { logo_key: string } }).snapshot.logo_key).to.match(/^companies\//);
  });

  it('requires an additional document before NEED_MORE_INFO can be resubmitted', async () => {
    const { company, ownerToken, adminToken } = await fixture();
    await request(app.getHttpServer()).post(`/v1/admin/companies/${company.id}/actions/need-more-info`).set('Authorization', adminToken)
      .send({ reason: 'Please add a certificate' }).expect(204);
    await request(app.getHttpServer()).post('/v1/companies/me/resubmit').set('Authorization', ownerToken).expect(422);
    await request(app.getHttpServer()).post('/v1/companies/me/documents').set('Authorization', ownerToken)
      .field('doc_type', 'REGISTRATION_CERT').attach('file', pdf, 'registration.pdf').expect(201);
    await request(app.getHttpServer()).post('/v1/companies/me/resubmit').set('Authorization', ownerToken).expect(204);
    expect((await db.company.findUniqueOrThrow({ where: { id: company.id } })).status).to.equal('PENDING');
  });

  it('suspends company members and restores only company-suspended accounts', async () => {
    const { company, owner, member, ownerToken, adminToken } = await fixture();
    await request(app.getHttpServer()).post('/v1/companies/me/documents').set('Authorization', ownerToken)
      .field('doc_type', 'REGISTRATION_CERT').attach('file', pdf, 'registration.pdf').expect(201);
    await request(app.getHttpServer()).post(`/v1/admin/companies/${company.id}/actions/verify`).set('Authorization', adminToken).send({}).expect(204);
    await request(app.getHttpServer()).post(`/v1/admin/companies/${company.id}/actions/suspend`).set('Authorization', adminToken)
      .send({ reason: 'Under investigation' }).expect(204);
    expect(await db.tokenDenylist.count({ where: { userId: { in: [owner.id, member.id] } } })).to.equal(2);
    expect(await db.outboxEvent.count({ where: { type: 'UserSuspended', aggregateId: { in: [owner.id, member.id] } } })).to.equal(2);
    await request(app.getHttpServer()).post(`/v1/admin/companies/${company.id}/actions/unsuspend`).set('Authorization', adminToken).send({}).expect(204);
    expect(await db.tokenDenylist.count({ where: { userId: { in: [owner.id, member.id] } } })).to.equal(0);
    expect((await db.user.findUniqueOrThrow({ where: { id: owner.id } })).status).to.equal('ACTIVE');
  });

  it('rejects duplicate Admin decisions and allows a rejected company to resubmit after editing', async () => {
    const { company, ownerToken, adminToken } = await fixture();
    const url = `/v1/admin/companies/${company.id}/actions/reject`;
    const decisions = await Promise.all([
      request(app.getHttpServer()).post(url).set('Authorization', adminToken).send({ reason: 'Incorrect filing' }),
      request(app.getHttpServer()).post(url).set('Authorization', adminToken).send({ reason: 'Incorrect filing' }),
    ]);
    expect(decisions.map((item) => item.status).sort()).to.deep.equal([204, 409]);
    expect(await db.outboxEvent.count({ where: { aggregateId: company.id, type: 'CompanyStatusChanged' } })).to.equal(1);
    await request(app.getHttpServer()).patch('/v1/companies/me').set('Authorization', ownerToken)
      .send({ website: 'https://updated.company.test' }).expect(200);
    expect((await db.company.findUniqueOrThrow({ where: { id: company.id } })).status).to.equal('PENDING');
  });
});
