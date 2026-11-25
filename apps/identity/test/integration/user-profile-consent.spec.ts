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
import { ConsentsModule } from '../../src/modules/consents/consents.module';
import { UsersModule } from '../../src/modules/users/users.module';
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

describe('Identity profile and resume consent (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let privateKey: string;
  let studentId: string;
  let advisorId: string;
  let hrId: string;
  let companyId: string;
  const auth = (id: string, role: string) => `Bearer ${jwt.sign({ role }, privateKey,
    { algorithm: 'RS256', subject: id, jwtid: randomUUID(), expiresIn: 900 })}`;

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_up_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base); url.pathname = `/${dbName}`;
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
      PrismaModule, UsersModule, ConsentsModule] }).compile();
    app = moduleRef.createNestApplication(); configureApp(app); await app.init();
    db = app.get(PrismaService);
    const universityId = (await db.university.create({ data: { name: 'Test U', emailDomain: 'test.ac.th' } })).id;
    advisorId = (await db.user.create({ data: { email: 'advisor@test.ac.th', passwordHash: 'secret',
      fullName: 'Advisor', role: 'ADVISOR', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId,
      advisorProfile: { create: { department: 'Engineering' } } } })).id;
    studentId = (await db.user.create({ data: { email: 'student@test.ac.th', passwordHash: 'secret',
      fullName: 'Student', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId,
      studentProfile: { create: { universityId, studentCode: 'S001', major: 'CS', yearLevel: 3,
        advisorId, advisorLinkStatus: 'LINKED' } } } })).id;
    companyId = (await db.company.create({ data: { name: 'Test Company', registrationNo: 'UP-001',
      emailDomain: 'company.test', status: 'VERIFIED' } })).id;
    hrId = (await db.user.create({ data: { email: 'owner@company.test', passwordHash: 'secret',
      fullName: 'Owner', role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date(),
      companyMember: { create: { companyId, memberRole: 'OWNER' } } } })).id;
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    for (const name of ['IDENTITY_DATABASE_URL', 'IDENTITY_DIRECT_URL', 'JWT_PUBLIC_KEY']) delete process.env[name];
  });

  it('returns only documented profile fields for Student, Advisor and HR', async () => {
    const student = await request(app.getHttpServer()).get('/v1/users/me')
      .set('Authorization', auth(studentId, 'STUDENT')).expect(200);
    expect(student.body).to.include({ id: studentId, full_name: 'Student', role: 'STUDENT', email_verified: true });
    expect(student.body.student).to.include({ student_code: 'S001', major: 'CS', year_level: 3,
      advisor_link_status: 'LINKED', advisor_id: advisorId });
    expect(student.body).not.to.have.property('password_hash');
    expect(student.body).not.to.have.property('refresh_tokens');
    const advisor = await request(app.getHttpServer()).get('/v1/users/me')
      .set('Authorization', auth(advisorId, 'ADVISOR')).expect(200);
    expect(advisor.body.advisor).to.deep.equal({ department: 'Engineering' });
    expect(student.body.university).to.deep.equal({ id: advisor.body.university.id, name: 'Test U' });
    expect(advisor.body.university.name).to.equal('Test U');
    const hr = await request(app.getHttpServer()).get('/v1/users/me')
      .set('Authorization', auth(hrId, 'COMPANY_HR')).expect(200);
    expect(hr.body.company).to.deep.equal({ id: companyId, name: 'Test Company', status: 'VERIFIED', member_role: 'OWNER' });
    expect(hr.body).not.to.have.property('university');
  });

  it('updates only name and phone and rejects invalid or inactive requests', async () => {
    await request(app.getHttpServer()).patch('/v1/users/me')
      .set('Authorization', auth(studentId, 'STUDENT')).send({ full_name: 'New Student', phone: ' 0812345678 ' }).expect(200);
    const updated = await db.user.findUniqueOrThrow({ where: { id: studentId } });
    expect(updated.fullName).to.equal('New Student'); expect(updated.phone).to.equal('0812345678');
    await request(app.getHttpServer()).patch('/v1/users/me')
      .set('Authorization', auth(studentId, 'STUDENT')).send({ phone: '' }).expect(200);
    expect((await db.user.findUniqueOrThrow({ where: { id: studentId } })).phone).to.equal(null);
    await request(app.getHttpServer()).patch('/v1/users/me')
      .set('Authorization', auth(studentId, 'STUDENT')).send({ full_name: null }).expect(400);
    await request(app.getHttpServer()).patch('/v1/users/me')
      .set('Authorization', auth(studentId, 'STUDENT')).send({ email: 'forged@test.ac.th' }).expect(400);
    await db.user.update({ where: { id: studentId }, data: { status: 'SUSPENDED' } });
    await request(app.getHttpServer()).get('/v1/users/me')
      .set('Authorization', auth(studentId, 'STUDENT')).expect(401);
    await db.user.update({ where: { id: studentId }, data: { status: 'ACTIVE' } });
  });

  it('records Resume Share consent only for an active Student and an existing company', async () => {
    const applicationId = randomUUID();
    await request(app.getHttpServer()).post('/v1/users/me/consents')
      .set('Authorization', auth(hrId, 'COMPANY_HR'))
      .send({ type: 'RESUME_SHARE', target_company_id: companyId }).expect(403);
    await request(app.getHttpServer()).post('/v1/users/me/consents')
      .set('Authorization', auth(studentId, 'STUDENT'))
      .send({ type: 'PRIVACY_POLICY', target_company_id: companyId }).expect(400);
    await request(app.getHttpServer()).post('/v1/users/me/consents')
      .set('Authorization', auth(studentId, 'STUDENT'))
      .send({ type: 'RESUME_SHARE', target_company_id: randomUUID() }).expect(404);
    await request(app.getHttpServer()).post('/v1/users/me/consents')
      .set('Authorization', auth(studentId, 'STUDENT'))
      .send({ type: 'RESUME_SHARE', target_company_id: companyId, application_id: applicationId }).expect(201);
    const row = await db.consent.findFirstOrThrow({ where: { userId: studentId, type: 'RESUME_SHARE' } });
    expect(row.targetCompanyId).to.equal(companyId);
    expect(row.applicationId).to.equal(applicationId);
    expect(row.revokedAt).to.equal(null);
  });
});
