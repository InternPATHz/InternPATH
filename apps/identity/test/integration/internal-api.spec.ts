import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { configureApp } from '@internpath/common';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import { InternalModule } from '../../src/internal/internal.module';
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

type Caller = 'gateway' | 'notification' | 'lifecycle';
const secrets: Record<Caller, string> = {
  gateway: 'g'.repeat(48), notification: 'n'.repeat(48), lifecycle: 'l'.repeat(48),
};
const serviceToken = (caller: Caller, options: { audience?: string; typ?: string; expiresIn?: number } = {}) => jwt.sign({}, secrets[caller], {
  algorithm: 'HS256', header: { alg: 'HS256', typ: options.typ ?? 'service' }, issuer: caller,
  audience: options.audience ?? 'identity', expiresIn: options.expiresIn ?? 300, jwtid: randomUUID(),
});

describe('Identity Internal API (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let adminId: string;
  let studentId: string;
  let companyId: string;
  let hrId: string;
  let deletedId: string;
  let universityId: string;

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_in_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base);
    url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT, env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl }, stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;
    process.env.IDENTITY_SERVICE_SECRET_GATEWAY = secrets.gateway;
    process.env.IDENTITY_SERVICE_SECRET_NOTIFICATION = secrets.notification;
    process.env.IDENTITY_SERVICE_SECRET_LIFECYCLE = secrets.lifecycle;
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule, InternalModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    universityId = (await db.university.create({ data: { name: 'Test University', emailDomain: 'test.ac.th' } })).id;
    studentId = (await db.user.create({ data: { email: 'student@test.ac.th', passwordHash: 'secret', fullName: 'Student',
      role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId,
      studentProfile: { create: { studentCode: 'S001', major: 'CS', yearLevel: 3 } } } })).id;
    adminId = (await db.user.create({ data: { email: 'admin@test.local', passwordHash: 'secret', fullName: 'Admin',
      role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() } })).id;
    deletedId = (await db.user.create({ data: { email: 'deleted@test.local', passwordHash: 'secret', fullName: 'Deleted',
      role: 'STUDENT', status: 'DELETED' } })).id;
    companyId = (await db.company.create({ data: { name: 'Test Company', registrationNo: 'REG-001', emailDomain: 'company.test' } })).id;
    hrId = (await db.user.create({ data: { email: 'owner@company.test', passwordHash: 'secret', fullName: 'Owner',
      role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(),
      companyMember: { create: { companyId, memberRole: 'OWNER' } } } })).id;
    await db.consent.create({ data: { userId: studentId, type: 'RESUME_SHARE', policyVersion: 'v1', targetCompanyId: companyId } });
    await db.tokenDenylist.create({ data: { userId: deletedId, reason: 'test' } });
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    for (const name of ['IDENTITY_DATABASE_URL', 'IDENTITY_DIRECT_URL', 'IDENTITY_SERVICE_SECRET_GATEWAY',
      'IDENTITY_SERVICE_SECRET_NOTIFICATION', 'IDENTITY_SERVICE_SECRET_LIFECYCLE']) delete process.env[name];
  });

  it('serves contacts and active Admin IDs only to Notification', async () => {
    const token = serviceToken('notification');
    const contact = await request(app.getHttpServer()).get(`/internal/v1/users/${studentId}/contact`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(contact.body).to.deep.equal({ user_id: studentId, email: 'student@test.ac.th', full_name: 'Student' });
    await request(app.getHttpServer()).get(`/internal/v1/users/${deletedId}/contact`).set('Authorization', `Bearer ${token}`).expect(404);
    const batch = await request(app.getHttpServer()).get(`/internal/v1/users/contacts?ids=${studentId},${deletedId},${hrId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(batch.body.map((item: { user_id: string }) => item.user_id)).to.deep.equal([studentId, hrId]);
    const admins = await request(app.getHttpServer()).get('/internal/v1/admins').set('Authorization', `Bearer ${token}`).expect(200);
    expect(admins.body).to.deep.equal([{ user_id: adminId }]);
  });

  it('returns student data, company members and consent only to Lifecycle', async () => {
    const token = serviceToken('lifecycle');
    const student = await request(app.getHttpServer()).get(`/internal/v1/students/${studentId}`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(student.body).to.include({ full_name: 'Student', major: 'CS', year_level: 3, university_id: universityId,
      advisor_link_status: 'NONE' });
    expect(student.body).to.not.have.property('email');
    const members = await request(app.getHttpServer()).get(`/internal/v1/companies/${companyId}/members`)
      .set('Authorization', `Bearer ${token}`).expect(200);
    expect(members.body).to.deep.equal([{ user_id: hrId, member_role: 'OWNER' }]);
    const consent = await request(app.getHttpServer()).post('/internal/v1/consents/check').set('Authorization', `Bearer ${token}`)
      .send({ student_user_id: studentId, company_id: companyId }).expect(200);
    const active = await db.consent.findFirstOrThrow({ where: { userId: studentId, revokedAt: null } });
    expect(consent.body).to.deep.equal({ has_consent: true, consent_id: active.id });
    await db.consent.updateMany({ where: { userId: studentId }, data: { revokedAt: new Date() } });
    const revoked = await request(app.getHttpServer()).post('/internal/v1/consents/check').set('Authorization', `Bearer ${token}`)
      .send({ student_user_id: studentId, company_id: companyId }).expect(200);
    expect(revoked.body).to.deep.equal({ has_consent: false });
  });

  it('checks consent in batch for Lifecycle: latest active consent per student, request order, consented only', async () => {
    const student = (email: string, code: string, status: 'ACTIVE' | 'SUSPENDED' = 'ACTIVE') => db.user.create({ data: {
      email, passwordHash: 'secret', fullName: code, role: 'STUDENT', status, emailVerifiedAt: new Date(), universityId,
      studentProfile: { create: { studentCode: code, major: 'CS', yearLevel: 3 } } } });
    const [a, b, c, suspended] = await Promise.all([student('a@test.ac.th', 'B001'), student('b@test.ac.th', 'B002'),
      student('c@test.ac.th', 'B003'), student('s@test.ac.th', 'B004', 'SUSPENDED')]);
    const otherCompany = await db.company.create({ data: { name: 'Other', registrationNo: 'REG-002', emailDomain: 'other.test' } });
    const grant = (userId: string, at: Date, target = companyId, revokedAt: Date | null = null) => db.consent.create({ data: {
      userId, type: 'RESUME_SHARE', policyVersion: 'v1', targetCompanyId: target, grantedAt: at, revokedAt } });
    await grant(a.id, new Date('2026-01-01'));
    const aLatest = await grant(a.id, new Date('2026-02-01'));
    await grant(b.id, new Date('2026-03-01'), companyId, new Date());
    await grant(c.id, new Date('2026-01-01'), otherCompany.id);
    await grant(suspended.id, new Date('2026-01-01'));
    const cLatest = await grant(c.id, new Date('2026-01-01'));
    const lifecycle = `Bearer ${serviceToken('lifecycle')}`;
    const ids = [c.id, b.id, randomUUID(), suspended.id, a.id, c.id];
    const batch = await request(app.getHttpServer()).post('/internal/v1/consents/check-batch').set('Authorization', lifecycle)
      .send({ company_id: companyId, student_user_ids: ids }).expect(200);
    expect(batch.body).to.deep.equal([
      { student_user_id: c.id, consent_id: cLatest.id },
      { student_user_id: a.id, consent_id: aLatest.id },
    ]);
    const single = await request(app.getHttpServer()).post('/internal/v1/consents/check').set('Authorization', lifecycle)
      .send({ student_user_id: a.id, company_id: companyId }).expect(200);
    expect(single.body).to.deep.equal({ has_consent: true, consent_id: aLatest.id });

    for (const student_user_ids of [[], Array(101).fill(a.id), ['bad'], 'not-array']) {
      await request(app.getHttpServer()).post('/internal/v1/consents/check-batch').set('Authorization', lifecycle)
        .send({ company_id: companyId, student_user_ids }).expect(400);
    }
    await request(app.getHttpServer()).post('/internal/v1/consents/check-batch')
      .set('Authorization', `Bearer ${serviceToken('notification')}`)
      .send({ company_id: companyId, student_user_ids: [a.id] }).expect(403);
  });

  it('returns student names in batch only to Lifecycle (no email, active students only like students/{id})', async () => {
    const suspendedId = (await db.user.create({ data: { email: 'suspended@test.ac.th', passwordHash: 'secret',
      fullName: 'Suspended Student', role: 'STUDENT', status: 'SUSPENDED', universityId,
      studentProfile: { create: { studentCode: 'S002', major: 'CS', yearLevel: 2 } } } })).id;
    const pendingId = (await db.user.create({ data: { email: 'pending@test.ac.th', passwordHash: 'secret',
      fullName: 'Pending Student', role: 'STUDENT', status: 'PENDING_EMAIL', universityId,
      studentProfile: { create: { studentCode: 'S003', major: 'CS', yearLevel: 1 } } } })).id;
    const unknownId = randomUUID();
    const lifecycle = `Bearer ${serviceToken('lifecycle')}`;
    const names = await request(app.getHttpServer())
      .get(`/internal/v1/students/names?ids=${suspendedId},${studentId},${pendingId},${deletedId},${hrId},${unknownId},${studentId}`)
      .set('Authorization', lifecycle).expect(200);
    expect(names.body).to.deep.equal([{ user_id: studentId, full_name: 'Student' }]);
    // สองเส้นทางต้องตรงกัน: คนที่ไม่อยู่ใน batch ต้องได้ 404 จาก students/{id}
    for (const id of [suspendedId, pendingId])
      await request(app.getHttpServer()).get(`/internal/v1/students/${id}`).set('Authorization', lifecycle).expect(404);

    await request(app.getHttpServer()).get(`/internal/v1/students/names?ids=${studentId}`)
      .set('Authorization', `Bearer ${serviceToken('notification')}`).expect(403);
    await request(app.getHttpServer()).get('/internal/v1/students/names').set('Authorization', lifecycle).expect(400);
    await request(app.getHttpServer()).get('/internal/v1/students/names?ids=bad').set('Authorization', lifecycle).expect(400);
    await request(app.getHttpServer()).get(`/internal/v1/students/names?ids=${Array(101).fill(studentId).join(',')}`)
      .set('Authorization', lifecycle).expect(400);
  });

  it('returns student summaries in batch only to Lifecycle (code, major, year; includes not-yet-active students; skips deleted and non-students)', async () => {
    const pendingId = (await db.user.create({ data: { email: 'summary-pending@test.ac.th', passwordHash: null,
      fullName: 'Summary Pending', role: 'STUDENT', status: 'PENDING_EMAIL', universityId,
      studentProfile: { create: { studentCode: 'SUM-1', major: 'Data Science', yearLevel: 4 } } } })).id;
    const lifecycle = `Bearer ${serviceToken('lifecycle')}`;
    const res = await request(app.getHttpServer())
      .get(`/internal/v1/students/summaries?ids=${pendingId},${studentId},${deletedId},${hrId},${randomUUID()},${pendingId}`)
      .set('Authorization', lifecycle).expect(200);
    expect(res.body).to.have.length(2);
    expect(res.body[0]).to.deep.equal({ user_id: pendingId, full_name: 'Summary Pending', student_code: 'SUM-1', major: 'Data Science', year_level: 4 });
    expect(res.body[1]).to.include.keys('user_id', 'full_name', 'student_code', 'major', 'year_level');
    expect(JSON.stringify(res.body)).to.not.include('@');
    await request(app.getHttpServer()).get(`/internal/v1/students/summaries?ids=${studentId}`).set('Authorization', `Bearer ${serviceToken('notification')}`).expect(403);
    await request(app.getHttpServer()).get('/internal/v1/students/summaries').set('Authorization', lifecycle).expect(400);
    await request(app.getHttpServer()).get('/internal/v1/students/summaries?ids=bad').set('Authorization', lifecycle).expect(400);
    await request(app.getHttpServer()).get(`/internal/v1/students/summaries?ids=${Array(101).fill(studentId).join(',')}`).set('Authorization', lifecycle).expect(400);
  });

  it('returns the denylist only to Gateway and enforces route allow-lists', async () => {
    const gateway = `Bearer ${serviceToken('gateway')}`;
    const notification = `Bearer ${serviceToken('notification')}`;
    const denylist = await request(app.getHttpServer()).get('/internal/v1/denylist').set('Authorization', gateway).expect(200);
    expect(denylist.body).to.deep.equal([{ user_id: deletedId }]);
    await request(app.getHttpServer()).get('/internal/v1/denylist').set('Authorization', notification).expect(403);
    await request(app.getHttpServer()).get(`/internal/v1/users/${studentId}/contact`).set('Authorization', gateway).expect(403);
    await request(app.getHttpServer()).get(`/internal/v1/companies/${companyId}/members`).set('Authorization', notification).expect(200);
  });

  it('rejects missing, wrong audience/type, expired and regular user tokens', async () => {
    const url = '/internal/v1/admins';
    await request(app.getHttpServer()).get(url).expect(401);
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${serviceToken('notification', { audience: 'job' })}`).expect(401);
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${serviceToken('notification', { typ: 'JWT' })}`).expect(401);
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${serviceToken('notification', { expiresIn: -1 })}`).expect(401);
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${serviceToken('notification', { expiresIn: 600 })}`).expect(401);
    const impersonation = jwt.sign({}, secrets.gateway, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'service' },
      issuer: 'notification', audience: 'identity', expiresIn: 300, jwtid: randomUUID() });
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${impersonation}`).expect(401);
    const forgedIssuer = jwt.sign({}, secrets.gateway, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'service' },
      issuer: 'toString', audience: 'identity', expiresIn: 300, jwtid: randomUUID() });
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${forgedIssuer}`).expect(401);
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const userToken = jwt.sign({ role: 'PLATFORM_ADMIN' }, pair.privateKey, { algorithm: 'RS256', subject: adminId });
    await request(app.getHttpServer()).get(url).set('Authorization', `Bearer ${userToken}`).expect(401);
  });

  it('validates batch size and consent UUIDs', async () => {
    const notification = `Bearer ${serviceToken('notification')}`;
    await request(app.getHttpServer()).get('/internal/v1/users/contacts?ids=bad').set('Authorization', notification).expect(400);
    await request(app.getHttpServer()).get(`/internal/v1/users/contacts?ids=${Array(101).fill(studentId).join(',')}`)
      .set('Authorization', notification).expect(400);
    await request(app.getHttpServer()).post('/internal/v1/consents/check')
      .set('Authorization', `Bearer ${serviceToken('lifecycle')}`).send({ student_user_id: 'bad', company_id: companyId }).expect(400);
  });
});
