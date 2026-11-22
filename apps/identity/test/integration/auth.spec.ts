import { execFileSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
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
import { hashPassword } from '../../src/modules/auth/password-hash';

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
  let failUnlockEmail = false;
  let failedSendAttempts = 0;
  const mailer = { send: async (email: string, purpose: string, token: string) => {
    if (failVerificationEmail && purpose === 'verify-email') { failedSendAttempts++; throw new Error('SMTP unavailable'); }
    if (failUnlockEmail && purpose === 'unlock-login') throw new Error('SMTP unavailable');
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

  const sha = (value: string) => createHash('sha256').update(value).digest('hex');
  /** นักศึกษาที่อาจารย์สร้าง (ยังไม่มีรหัสผ่าน) + โทเคนคำเชิญที่รู้ค่าดิบ */
  async function invitedStudent(email: string, over: { expiresAt?: Date } = {}) {
    const university = await db.university.upsert({ where: { emailDomain: 'test.ac.th' }, create: { emailDomain: 'test.ac.th', name: 'test.ac.th' }, update: {} });
    const advisor = await db.user.create({ data: { email: `adv-${randomBytes(3).toString('hex')}@test.ac.th`, passwordHash: 'x', fullName: 'Advisor', role: 'ADVISOR', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId: university.id } });
    const user = await db.user.create({ data: { email, passwordHash: null, fullName: 'Student Test', role: 'STUDENT', status: 'PENDING_EMAIL', universityId: university.id,
      studentProfile: { create: { universityId: university.id, studentCode: `ST${randomBytes(3).toString('hex')}`, major: 'Computer Science', yearLevel: 3, advisorId: advisor.id, advisorLinkStatus: 'LINKED', createdByAdvisorId: advisor.id } } } });
    const token = randomBytes(32).toString('base64url');
    await db.emailToken.create({ data: { userId: user.id, purpose: 'STUDENT_INVITATION', tokenHash: sha(token), expiresAt: over.expiresAt ?? new Date(Date.now() + 7 * 86_400_000) } });
    return { user, token };
  }

  it('student: no self-registration; invitation sets password, activates account, records consent; then login, refresh rotation and reuse revocation', async () => {
    const body = { email: 'student@test.ac.th', password: 'correct horse battery' };
    await request(app.getHttpServer()).post('/v1/auth/register/student').send({ ...body, full_name: 'x', student_code: 'x', major: 'x', year_level: 3, accept_privacy: true }).expect(404);
    const { user, token } = await invitedStudent(body.email);
    expect(user.passwordHash).to.equal(null);
    // ยังไม่ตั้งรหัสผ่าน ⇒ เข้าสู่ระบบไม่ได้ ไม่ว่าจะส่งรหัสอะไร และรีเซ็ตรหัสผ่านไม่ออกโทเคน
    await request(app.getHttpServer()).post('/v1/auth/login').send(body).expect(401);
    await request(app.getHttpServer()).post('/v1/auth/password/forgot').send({ email: body.email }).expect(204);
    expect(await db.emailToken.count({ where: { userId: user.id, purpose: 'RESET_PASSWORD' } })).to.equal(0);
    // โทเคนคำเชิญใช้กับ verify-email ไม่ได้ และตรวจข้อมูลขาเข้า
    await request(app.getHttpServer()).post('/v1/auth/verify-email').send({ token }).expect(400);
    await request(app.getHttpServer()).post('/v1/auth/student-invitations/accept').send({ token, password: 'short', accept_privacy: true }).expect(400);
    await request(app.getHttpServer()).post('/v1/auth/student-invitations/accept').send({ token, password: body.password, accept_privacy: false }).expect(400);
    const bad = await request(app.getHttpServer()).post('/v1/auth/student-invitations/accept').send({ token: 'wrong-token', password: body.password, accept_privacy: true }).expect(400);
    expect(bad.body.error.code).to.equal('VALIDATION_FAILED');
    expect(bad.body.error.details[0].issue).to.equal('INVALID_TOKEN');
    expect(await db.consent.count({ where: { userId: user.id } })).to.equal(0);
    await request(app.getHttpServer()).post('/v1/auth/student-invitations/accept').send({ token, password: body.password, accept_privacy: true }).expect(204);
    await request(app.getHttpServer()).post('/v1/auth/student-invitations/accept').send({ token, password: 'another password 12345', accept_privacy: true }).expect(400);
    const accepted = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(accepted.status).to.equal('ACTIVE');
    expect(accepted.emailVerifiedAt).to.be.instanceOf(Date);
    expect(accepted.passwordHash).to.match(/^\$argon2id\$/);
    expect(await db.consent.count({ where: { userId: user.id, type: 'PRIVACY_POLICY' } })).to.equal(1);
    expect(await db.statusHistory.count({ where: { entityId: user.id, toStatus: 'ACTIVE' } })).to.equal(1);
    const login = await request(app.getHttpServer()).post('/v1/auth/login').send({ email: body.email, password: body.password }).expect(200);
    expect(login.body.expires_in).to.equal(900);
    const claims = jwt.verify(login.body.access_token, publicKey, { algorithms: ['RS256'] }) as jwt.JwtPayload;
    expect(claims.role).to.equal('STUDENT');
    expect(claims.university_id).to.equal(user.universityId);
    expect(claims.advisor_id).to.equal((await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: user.id } })).advisorId);
    expect(claims).to.not.have.property('company_categories');
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
    const company = { company: { name: 'Test Company', registration_no: '0105550000123' }, user: { email: 'owner@gmail.com', password: 'correct horse battery', full_name: 'Owner' }, accept_privacy: true };
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

  it('requires exactly 13 digits for company registration numbers', async () => {
    const body = { company: { name: 'Invalid Registration', registration_no: '' },
      user: { email: 'invalid-registration@test-company.com', password: 'correct horse battery', full_name: 'Owner' },
      accept_privacy: true };
    for (const registrationNo of ['123456789012', '12345678901234', '12345678901A3']) {
      body.company.registration_no = registrationNo;
      await request(app.getHttpServer()).post('/v1/auth/register/company').send(body).expect(400);
    }
    expect(await db.company.count({ where: { name: body.company.name } })).to.equal(0);
  });

  it('keeps committed advisor and company accounts when verification email fails', async () => {
    const cases = [
      { route: 'advisor', email: 'mail-fail-advisor@test.ac.th', conflict: 'ACCOUNT_EXISTS', body: {
        email: 'mail-fail-advisor@test.ac.th', password: 'correct horse battery', full_name: 'Advisor Mail Failure',
        department: 'Science', accept_privacy: true,
      } },
      { route: 'company', email: 'mail-fail-owner@test-company.com', conflict: 'ACCOUNT_OR_COMPANY_EXISTS', body: {
        company: { name: 'Mail Failure Company', registration_no: '0105550000456' },
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

  it('lets the owner use a one-time email link and password despite an attacker-triggered lock', async () => {
    const email = 'locked-user@test.ac.th';
    const password = 'correct horse battery';
    const user = await db.user.create({ data: { email, passwordHash: await hashPassword(password),
      fullName: 'Locked User', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date() } });
    for (let attempt = 0; attempt < 5; attempt++) {
      await request(app.getHttpServer()).post('/v1/auth/login')
        .send({ email, password: 'attacker wrong password' }).expect(401);
    }
    await request(app.getHttpServer()).post('/v1/auth/login').send({ email, password }).expect(429);
    const before = emails.length;
    await request(app.getHttpServer()).post('/v1/auth/login/unlock/request')
      .send({ email: 'nobody@example.com' }).expect(204);
    expect(emails.length).to.equal(before);
    await Promise.all([
      request(app.getHttpServer()).post('/v1/auth/login/unlock/request').send({ email }).expect(204),
      request(app.getHttpServer()).post('/v1/auth/login/unlock/request').send({ email }).expect(204),
    ]);
    expect(emails.length).to.equal(before + 1);
    const unlockToken = emails.at(-1)!.token;
    expect(emails.at(-1)!.purpose).to.equal('unlock-login');
    const stored = await db.emailToken.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(unlockToken).digest('hex') } });
    expect(stored.purpose).to.equal('LOGIN_UNLOCK');
    const other = await db.user.create({ data: { email: 'other-locked-user@test.ac.th',
      passwordHash: user.passwordHash, fullName: 'Other User', role: 'STUDENT', status: 'ACTIVE',
      emailVerifiedAt: new Date() } });
    await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email: other.email, password, unlock_token: unlockToken }).expect(401);
    await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email, password, unlock_token: 'invalid-unlock-token' }).expect(401);
    const unlocked = await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email, password, unlock_token: unlockToken }).expect(200);
    expect(unlocked.body.user.id).to.equal(user.id);
    await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email, password, unlock_token: unlockToken }).expect(401);
    const after = await db.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(after.failedLoginCount).to.equal(0);
    expect(after.lockedUntil).to.equal(null);

    await db.user.update({ where: { id: user.id }, data: { failedLoginCount: 5,
      lockedUntil: new Date(Date.now() + 15 * 60_000) } });
    const wrongToken = randomBytes(32).toString('base64url');
    const wrongTokenHash = createHash('sha256').update(wrongToken).digest('hex');
    await db.emailToken.create({ data: { userId: user.id, purpose: 'LOGIN_UNLOCK',
      tokenHash: wrongTokenHash, expiresAt: new Date(Date.now() + 15 * 60_000) } });
    await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email, password: 'still wrong', unlock_token: wrongToken }).expect(401);
    expect((await db.emailToken.findUniqueOrThrow({ where: { tokenHash: wrongTokenHash } })).usedAt).to.equal(null);
    await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email, password, unlock_token: wrongToken }).expect(200);
    expect((await db.emailToken.findUniqueOrThrow({ where: { tokenHash: wrongTokenHash } })).usedAt).to.be.instanceOf(Date);
    await request(app.getHttpServer()).post('/v1/auth/login')
      .send({ email, password, unlock_token: wrongToken }).expect(401);
  });

  it('keeps unlock requests generic when SMTP is unavailable and does not leave a usable token', async () => {
    const user = await db.user.create({ data: { email: 'smtp-unlock@test.ac.th', passwordHash: 'unused',
      fullName: 'SMTP Unlock', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(),
      failedLoginCount: 5, lockedUntil: new Date(Date.now() + 15 * 60_000) } });
    failUnlockEmail = true;
    try {
      await request(app.getHttpServer()).post('/v1/auth/login/unlock/request')
        .send({ email: user.email }).expect(204);
    } finally { failUnlockEmail = false; }
    const tokens = await db.emailToken.findMany({ where: { userId: user.id, purpose: 'LOGIN_UNLOCK' } });
    expect(tokens).to.have.length(1);
    expect(tokens[0].usedAt).to.be.instanceOf(Date);
  });
});
