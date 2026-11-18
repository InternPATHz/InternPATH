import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { configureApp, OutboxWriter } from '@internpath/common';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { CompanyMembersModule } from '../../src/modules/company-members/company-members.module';
import { InvitationMailer } from '../../src/modules/company-members/invitation-mailer';
import { verifyPassword } from '../../src/modules/auth/password-hash';
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
class TestOutboxModule {}

describe('Identity company members and Owner workflow (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let privateKey: string;
  let invitedToken = '';
  let ownerId: string;
  let memberId: string;
  let adminId: string;
  let companyId: string;
  const headers = (id: string, role: string) => ({ Authorization: `Bearer ${jwt.sign({ role }, privateKey,
    { algorithm: 'RS256', subject: id, expiresIn: 900, jwtid: randomUUID() })}` });

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_cm_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base);
    url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT, env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl }, stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    privateKey = pair.privateKey;
    process.env.JWT_PUBLIC_KEY = pair.publicKey;
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule, TestOutboxModule, CompanyMembersModule] })
      .overrideProvider(InvitationMailer).useValue({ send: async (_email: string, token: string) => { invitedToken = token; } })
      .compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    companyId = (await db.company.create({ data: { name: 'Test Company', registrationNo: 'CM-001',
      emailDomain: 'company.test', status: 'VERIFIED' } })).id;
    ownerId = (await db.user.create({ data: { email: 'owner@company.test', passwordHash: 'hash', fullName: 'Owner',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(),
      companyMember: { create: { companyId, memberRole: 'OWNER' } } } })).id;
    memberId = (await db.user.create({ data: { email: 'member@company.test', passwordHash: 'hash', fullName: 'Member',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(),
      companyMember: { create: { companyId, memberRole: 'MEMBER' } } } })).id;
    adminId = (await db.user.create({ data: { email: 'admin@test.local', passwordHash: 'hash', fullName: 'Admin',
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() } })).id;
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    for (const name of ['IDENTITY_DATABASE_URL', 'IDENTITY_DIRECT_URL', 'JWT_PUBLIC_KEY']) delete process.env[name];
  });

  it('limits invitations to the active Owner and company email domain; consumes the token once', async () => {
    await request(app.getHttpServer()).post('/v1/companies/me/invitations')
      .set(headers(memberId, 'COMPANY_HR')).send({ email: 'new@company.test' }).expect(403);
    await request(app.getHttpServer()).post('/v1/companies/me/invitations')
      .set(headers(ownerId, 'COMPANY_HR')).send({ email: 'new@outside.test' }).expect(400);
    await request(app.getHttpServer()).post('/v1/companies/me/invitations')
      .set(headers(ownerId, 'COMPANY_HR')).send({ email: 'new@company.test' }).expect(201);
    expect(invitedToken.length).to.be.greaterThan(20);
    expect(await db.companyInvitation.findFirst({ where: { email: 'new@company.test' }, select: { tokenHash: true } }))
      .not.to.have.property('token', invitedToken);
    await request(app.getHttpServer()).post('/v1/auth/invitations/accept')
      .send({ token: 'bad', password: 'long-password-123', full_name: 'New Member' }).expect(400);
    await request(app.getHttpServer()).post('/v1/auth/invitations/accept')
      .send({ token: invitedToken, password: 'long-password-123', full_name: 'New Member' }).expect(201);
    await request(app.getHttpServer()).post('/v1/auth/invitations/accept')
      .send({ token: invitedToken, password: 'long-password-123', full_name: 'New Member' }).expect(400);
    const created = await db.user.findUniqueOrThrow({ where: { email: 'new@company.test' }, include: { companyMember: true } });
    expect(created.companyMember?.memberRole).to.equal('MEMBER');
    expect(created.emailVerifiedAt).not.to.equal(null);
    expect(await verifyPassword(created.passwordHash, 'long-password-123')).to.equal(true);
    const members = await request(app.getHttpServer()).get('/v1/companies/me/members')
      .set(headers(ownerId, 'COMPANY_HR')).expect(200);
    expect(members.body.data.map((item: { user_id: string }) => item.user_id)).to.include(created.id);
    expect(members.body.data[0]).to.include({ member_role: 'OWNER' });
    expect(members.body.meta).to.deep.equal({ page: 1, page_size: 20, total: members.body.data.length });
    const paged = await request(app.getHttpServer()).get('/v1/companies/me/members?page=2&page_size=1')
      .set(headers(ownerId, 'COMPANY_HR')).expect(200);
    expect(paged.body.data).to.have.length(1);
    expect(paged.body.data[0].user_id).to.equal(members.body.data[1].user_id);
    expect(paged.body.meta).to.deep.equal({ page: 2, page_size: 1, total: members.body.meta.total });
    await request(app.getHttpServer()).get('/v1/companies/me/members?page_size=101')
      .set(headers(ownerId, 'COMPANY_HR')).expect(400);
  });

  it('requires the receiving Member to accept an Owner transfer, with event and audit', async () => {
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer')
      .set(headers(ownerId, 'COMPANY_HR')).send({ to_user_id: memberId }).expect(201);
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer/actions/decline')
      .set(headers(memberId, 'COMPANY_HR')).expect(204);
    expect((await db.companyMember.findUniqueOrThrow({ where: { userId: ownerId } })).memberRole).to.equal('OWNER');
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer')
      .set(headers(ownerId, 'COMPANY_HR')).send({ to_user_id: memberId }).expect(201);
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer/actions/cancel')
      .set(headers(ownerId, 'COMPANY_HR')).expect(204);
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer')
      .set(headers(ownerId, 'COMPANY_HR')).send({ to_user_id: memberId }).expect(201);
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer/actions/accept')
      .set(headers(ownerId, 'COMPANY_HR')).expect(403);
    await request(app.getHttpServer()).post('/v1/companies/me/owner-transfer/actions/accept')
      .set(headers(memberId, 'COMPANY_HR')).expect(204);
    expect((await db.companyMember.findUniqueOrThrow({ where: { userId: ownerId } })).memberRole).to.equal('MEMBER');
    expect((await db.companyMember.findUniqueOrThrow({ where: { userId: memberId } })).memberRole).to.equal('OWNER');
    expect(await db.adminAuditLog.count({ where: { action: 'COMPANY_OWNER_TRANSFER', targetId: companyId } })).to.equal(1);
    expect(await db.outboxEvent.count({ where: { type: 'CompanyStatusChanged', aggregateId: companyId } })).to.equal(1);
  });

  it('removes a Member and invalidates existing access and refresh tokens', async () => {
    await db.refreshToken.create({ data: { userId: ownerId, tokenHash: 'test-refresh', familyId: randomUUID(),
      expiresAt: new Date(Date.now() + 60_000) } });
    await request(app.getHttpServer()).delete(`/v1/companies/me/members/${memberId}`)
      .set(headers(ownerId, 'COMPANY_HR')).expect(403);
    await request(app.getHttpServer()).delete(`/v1/companies/me/members/${ownerId}`)
      .set(headers(memberId, 'COMPANY_HR')).expect(204);
    expect(await db.companyMember.findUnique({ where: { userId: ownerId } })).to.equal(null);
    expect((await db.user.findUniqueOrThrow({ where: { id: ownerId } })).status).to.equal('SUSPENDED');
    expect(await db.tokenDenylist.findUnique({ where: { userId: ownerId } })).not.to.equal(null);
    expect((await db.refreshToken.findUniqueOrThrow({ where: { tokenHash: 'test-refresh' } })).revokedAt).not.to.equal(null);
    expect(await db.outboxEvent.count({ where: { type: 'UserSuspended', aggregateId: ownerId } })).to.equal(1);
    expect(await db.statusHistory.count({ where: { entity: 'USER', entityId: ownerId, toStatus: 'SUSPENDED' } })).to.equal(1);
    await request(app.getHttpServer()).get('/v1/companies/me/members')
      .set(headers(ownerId, 'COMPANY_HR')).expect(403);
  });

  it('lets only an Admin appoint an active Member when a company has no Owner', async () => {
    const emptyCompany = await db.company.create({ data: { name: 'No Owner', registrationNo: 'CM-002',
      emailDomain: 'noowner.test', status: 'VERIFIED' } });
    const candidate = await db.user.create({ data: { email: 'candidate@noowner.test', passwordHash: 'hash',
      fullName: 'Candidate', role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(),
      companyMember: { create: { companyId: emptyCompany.id, memberRole: 'MEMBER' } } } });
    await request(app.getHttpServer()).post(`/v1/admin/companies/${emptyCompany.id}/owner`)
      .set(headers(memberId, 'COMPANY_HR')).send({ user_id: candidate.id }).expect(403);
    await request(app.getHttpServer()).post(`/v1/admin/companies/${emptyCompany.id}/owner`)
      .set(headers(adminId, 'PLATFORM_ADMIN')).send({ user_id: candidate.id }).expect(204);
    expect((await db.companyMember.findUniqueOrThrow({ where: { userId: candidate.id } })).memberRole).to.equal('OWNER');
    expect(await db.adminAuditLog.count({ where: { action: 'COMPANY_OWNER_APPOINT', targetId: emptyCompany.id } })).to.equal(1);
    await request(app.getHttpServer()).post(`/v1/admin/companies/${emptyCompany.id}/owner`)
      .set(headers(adminId, 'PLATFORM_ADMIN')).send({ user_id: candidate.id }).expect(409);
  });
});
