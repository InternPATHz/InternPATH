import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
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
import { AuthMailer } from '../../src/modules/auth/auth.mailer';
import { AuthModule } from '../../src/modules/auth/auth.module';
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

describe('Identity Auth API (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  const emails: Array<{ email: string; purpose: string; token: string }> = [];
  let failVerificationEmail = false;
  let failedSendAttempts = 0;
  const mailer = { send: async (email: string, purpose: string, token: string) => {
    if (failVerificationEmail && purpose === 'verify-email') { failedSendAttempts++; throw new Error('SMTP unavailable'); }
    emails.push({ email, purpose, token });
  } };
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_auth_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base);
    url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT,
      env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl },
      stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;
    process.env.JWT_PRIVATE_KEY = privateKey;
    process.env.JWT_PUBLIC_KEY = publicKey;
    const module = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true }), PrismaModule, AuthModule] })
      .overrideProvider(AuthMailer).useValue(mailer).compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    delete process.env.IDENTITY_DATABASE_URL;
    delete process.env.IDENTITY_DIRECT_URL;
    delete process.env.JWT_PRIVATE_KEY;
    delete process.env.JWT_PUBLIC_KEY;
  });

  it('student: consent, email verification, login, refresh rotation and reuse revocation', async () => {
    const body = { email: 'Student@Test.ac.th', password: 'correct horse battery', full_name: 'Student Test', student_code: 'ST001', major: 'Computer Science', year_level: 3, accept_privacy: true };
    await request(app.getHttpServer()).post('/v1/auth/register/student').send(body).expect(201);
    const user = await db.user.findUniqueOrThrow({ where: { email: body.email.toLowerCase() } });
    expect(user.status).to.equal('PENDING_EMAIL');
    expect(user.passwordHash).to.match(/^\$argon2id\$/);
    expect(await db.consent.count({ where: { userId: user.id, type: 'PRIVACY_POLICY' } })).to.equal(1);
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: body.email, password: body.password }).expect(403);
    const token = emails.find((item) => item.email === body.email.toLowerCase())?.token;
    expect(token).to.be.a('string');
    expect(await db.emailToken.count({ where: { tokenHash: token } })).to.equal(0);
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token }).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token }).expect(400);
    const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: body.email, password: body.password }).expect(200);
    expect(login.body.expires_in).to.equal(900);
    const claims = jwt.verify(login.body.access_token, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(claims.role).to.equal('STUDENT');
    expect(claims.university_id).to.equal(user.universityId);
    await db.user.update({ where: { id: user.id }, data: { fullName: 'Updated Student' } });
    const refresh = await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refresh_token: login.body.refresh_token }).expect(200);
    expect(refresh.body.refresh_token).to.not.equal(login.body.refresh_token);
    expect(refresh.body.user.full_name).to.equal('Updated Student');
    await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refresh_token: login.body.refresh_token }).expect(401);
    await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refresh_token: refresh.body.refresh_token }).expect(401);
  });

  it('advisor waits for approval; company gets OWNER and public email is rejected', async () => {
    await request(app.getHttpServer()).post('/v1/auth/register/advisor').send({ email: 'advisor@test.ac.th', password: 'correct horse battery', full_name: 'Advisor', department: 'Science', accept_privacy: true }).expect(201);
    const advisorToken = emails.find((item) => item.email === 'advisor@test.ac.th')?.token;
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token: advisorToken }).expect(204);
    expect((await db.user.findUniqueOrThrow({ where: { email: 'advisor@test.ac.th' } })).status).to.equal('PENDING_APPROVAL');
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'advisor@test.ac.th', password: 'correct horse battery' }).expect(403);
    const company = { company: { name: 'Test Company', registration_no: 'TC-001' }, user: { email: 'owner@gmail.com', password: 'correct horse battery', full_name: 'Owner' }, accept_privacy: true };
    const invalid = await request(app.getHttpServer()).post('/v1/auth/register/company').send(company).expect(400);
    expect(invalid.body.error.code).to.equal('PUBLIC_EMAIL_NOT_ALLOWED');
    company.user.email = 'owner@test-company.com';
    await request(app.getHttpServer()).post('/v1/auth/register/company').send(company).expect(201);
    const member = await db.companyMember.findFirstOrThrow({ include: { company: true } });
    expect(member.memberRole).to.equal('OWNER');
    expect(member.company.status).to.equal('PENDING');
    const companyToken = emails.find((item) => item.email === company.user.email)?.token;
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token: companyToken }).expect(204);
    const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: company.user.email, password: company.user.password }).expect(200);
    const claims = jwt.verify(login.body.access_token, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(claims.company_id).to.equal(member.companyId);
    expect(claims.company_role).to.equal('OWNER');
    await request(app.getHttpServer()).post('/v1/auth/logout').set('Authorization', `Bearer ${login.body.access_token}`).send({ refresh_token: login.body.refresh_token }).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/refresh').send({ refresh_token: login.body.refresh_token }).expect(401);
  });

  it('keeps committed student, advisor and company accounts when verification email fails', async () => {
    const cases = [
      { route: 'student', email: 'mail-fail-student@test.ac.th', conflict: 'ACCOUNT_EXISTS', body: {
        email: 'mail-fail-student@test.ac.th', password: 'correct horse battery', full_name: 'Student Mail Failure',
        student_code: 'MAIL-FAIL-STUDENT', major: 'Computer Science', year_level: 3, accept_privacy: true,
      } },
      { route: 'advisor', email: 'mail-fail-advisor@test.ac.th', conflict: 'ACCOUNT_EXISTS', body: {
        email: 'mail-fail-advisor@test.ac.th', password: 'correct horse battery', full_name: 'Advisor Mail Failure',
        department: 'Science', accept_privacy: true,
      } },
      { route: 'company', email: 'mail-fail-owner@test-company.com', conflict: 'ACCOUNT_OR_COMPANY_EXISTS', body: {
        company: { name: 'Mail Failure Company', registration_no: 'MAIL-FAIL-COMPANY' },
        user: { email: 'mail-fail-owner@test-company.com', password: 'correct horse battery', full_name: 'Owner Mail Failure' },
        accept_privacy: true,
      } },
    ];
    const attemptsBefore = failedSendAttempts;
    failVerificationEmail = true;
    try {
      for (const item of cases) {
        await request(app.getHttpServer()).post(`/v1/auth/register/${item.route}`).send(item.body).expect(201);
        const user = await db.user.findUniqueOrThrow({ where: { email: item.email } });
        expect(user.status).to.equal('PENDING_EMAIL');
        expect(await db.emailToken.count({ where: { userId: user.id, purpose: 'VERIFY_EMAIL' } })).to.equal(1);
        const retry = await request(app.getHttpServer()).post(`/v1/auth/register/${item.route}`).send(item.body).expect(409);
        expect(retry.body.error.code).to.equal(item.conflict);
      }
    } finally { failVerificationEmail = false; }
    expect(failedSendAttempts - attemptsBefore).to.equal(cases.length);
  });

  it('password reset is one-time and revokes sessions; unknown address gets same response', async () => {
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'student@test.ac.th', password: 'wrong password' }).expect(401);
    }
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'student@test.ac.th', password: 'correct horse battery' }).expect(429);
    await request(app.getHttpServer()).post('/v1/auth/password/forgot').send({ email: 'unknown@example.com' }).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/password/forgot').send({ email: 'student@test.ac.th' }).expect(204);
    const token = emails.find((item) => item.email === 'student@test.ac.th' && item.purpose === 'reset-password')?.token;
    expect(token).to.be.a('string');
    await request(app.getHttpServer()).post('/v1/auth/password/reset').send({ token, new_password: 'new password 12345' }).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/password/reset').send({ token, new_password: 'another password 12345' }).expect(400);
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email: 'student@test.ac.th', password: 'new password 12345' }).expect(200);
  });
});
