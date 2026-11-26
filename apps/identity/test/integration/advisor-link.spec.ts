import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID, randomInt } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { Client } from 'pg';
import request from 'supertest';
import sinon from 'sinon';
import { AuthMailer } from '../../src/modules/auth/auth.mailer';
import { AdvisorLinkModule } from '../../src/modules/advisor-links/advisor-link.module';
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

@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class StubMessagingModule {}

describe('Identity advisor-created students (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let studentId: string;
  let adminId: string;
  let advisorA: string;
  let advisorB: string;
  let advisorC: string;
  let outsider: string;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const bearer = (userId: string, role: 'STUDENT' | 'ADVISOR' | 'PLATFORM_ADMIN') => `Bearer ${jwt.sign({ role }, privateKey, { algorithm: 'RS256', subject: userId, jwtid: randomUUID(), expiresIn: 900 })}`;

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_link_${randomBytes(4).toString('hex')}`;
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
    process.env.JWT_PUBLIC_KEY = publicKey;
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, StubMessagingModule, AdvisorLinkModule, UsersModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    const uni = await db.university.create({ data: { name: 'Test University', emailDomain: 'test.ac.th' } });
    const otherUni = await db.university.create({ data: { name: 'Other University', emailDomain: 'other.ac.th' } });
    const user = await db.user.create({ data: { email: 'student@test.ac.th', passwordHash: 'test-only', fullName: 'Student', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId: uni.id,
      studentProfile: { create: { universityId: uni.id, studentCode: 'S001', major: 'CS', yearLevel: 3 } } } });
    studentId = user.id;
    adminId = (await db.user.create({ data: { email: 'admin@test.ac.th', passwordHash: 'test-only', fullName: 'Admin', role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: new Date() } })).id;
    advisorA = (await db.user.create({ data: { email: 'a@test.ac.th', passwordHash: 'test-only', fullName: 'Advisor A', role: 'ADVISOR', status: 'PENDING_APPROVAL', emailVerifiedAt: new Date(), universityId: uni.id, advisorProfile: { create: { department: 'Science' } } } })).id;
    advisorB = (await db.user.create({ data: { email: 'b@test.ac.th', passwordHash: 'test-only', fullName: 'Advisor B', role: 'ADVISOR', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId: uni.id, advisorProfile: { create: { department: 'Mathematics' } } } })).id;
    advisorC = (await db.user.create({ data: { email: 'c@test.ac.th', passwordHash: 'test-only', fullName: 'Advisor C', role: 'ADVISOR', status: 'PENDING_APPROVAL', emailVerifiedAt: new Date(), universityId: uni.id, advisorProfile: { create: { department: 'Engineering' } } } })).id;
    outsider = (await db.user.create({ data: { email: 'd@other.ac.th', passwordHash: 'test-only', fullName: 'Advisor D', role: 'ADVISOR', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId: otherUni.id, advisorProfile: { create: { department: 'Science' } } } })).id;
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    delete process.env.IDENTITY_DATABASE_URL;
    delete process.env.IDENTITY_DIRECT_URL;
    delete process.env.JWT_PUBLIC_KEY;
  });

  const http = () => request(app.getHttpServer());
  const advisorAuth = (id: string) => ({ Authorization: bearer(id, 'ADVISOR') });
  const adminAuth = () => ({ Authorization: bearer(adminId, 'PLATFORM_ADMIN') });
  /** รหัสนักศึกษา 10 หลักแบบสุ่ม (ตรงรูปแบบ STUDENT_CODE_PATTERN) */
  const studentCode = () => `66${randomInt(0, 100_000_000).toString().padStart(8, '0')}`;
  const newStudent = (over: Record<string, unknown> = {}) => ({
    email: `new${randomBytes(3).toString('hex')}@test.ac.th`, full_name: 'นักศึกษา ใหม่', student_code: studentCode(), major: 'CS', year_level: 4, ...over,
  });

  it('Admin approves a pending advisor once, with audit and approval timestamp', async () => {
    const pending = await http().get('/v1/admin/advisors?status=PENDING_APPROVAL').set(adminAuth()).expect(200);
    expect(pending.body.meta.total).to.equal(2);
    expect(pending.body.data[0]).to.include({ university_name: 'Test University' });
    const sameUni = pending.body.data[0].university_id as string;
    const byUni = await http().get(`/v1/admin/advisors?university_id=${sameUni}`).set(adminAuth()).expect(200);
    expect(byUni.body.meta.total).to.equal(3);
    expect(byUni.body.data.map((row: { id: string }) => row.id)).to.not.include(outsider);
    await http().get('/v1/admin/advisors?university_id=bad').set(adminAuth()).expect(400);
    await http().post(`/v1/admin/advisors/${advisorA}/actions/approve`).set(adminAuth()).send({}).expect(204);
    await http().post(`/v1/admin/advisors/${advisorA}/actions/approve`).set(adminAuth()).send({}).expect(409);
    const profile = await db.advisorProfile.findUniqueOrThrow({ where: { userId: advisorA } });
    expect(profile.approvedBy).to.equal(adminId);
    expect(await db.adminAuditLog.count({ where: { targetId: advisorA } })).to.equal(1);
  });

  it('removed self-service routes: no student register, no advisor list, no student-chosen advisor link', async () => {
    await http().post('/v1/auth/register/student').send(newStudent({ password: 'a-long-test-password', accept_privacy: true })).expect(404);
    await http().get('/v1/advisors').set('Authorization', bearer(studentId, 'STUDENT')).expect(404);
    await http().post('/v1/users/me/advisor-link').set('Authorization', bearer(studentId, 'STUDENT')).send({ advisor_id: advisorB }).expect(404);
    await http().get('/v1/advisor-links/requests').set(advisorAuth(advisorB)).expect(404);
  });

  it('advisor creates a student: PENDING_EMAIL account without password, LINKED at once, 7-day invitation and AdvisorLinkChanged', async () => {
    const header = { 'X-Correlation-Id': randomUUID() };
    const body = newStudent({ email: 'Created.Student@TEST.ac.th' });
    const res = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).set(header).send(body).expect(201);
    expect(res.body).to.have.all.keys('student_user_id', 'email', 'invitation_expires_at');
    expect(res.body.email).to.equal('created.student@test.ac.th');
    const days = (new Date(res.body.invitation_expires_at).getTime() - Date.now()) / 86_400_000;
    expect(days).to.be.within(6.99, 7.01);
    expect(res.headers['x-correlation-id']).to.equal(header['X-Correlation-Id']);

    const user = await db.user.findUniqueOrThrow({ where: { id: res.body.student_user_id }, include: { studentProfile: true } });
    expect(user).to.include({ role: 'STUDENT', status: 'PENDING_EMAIL', passwordHash: null, emailVerifiedAt: null });
    expect(user.universityId).to.equal((await db.user.findUniqueOrThrow({ where: { id: advisorB } })).universityId);
    expect(user.studentProfile).to.include({ studentCode: body.student_code, major: 'CS', yearLevel: 4, advisorId: advisorB, createdByAdvisorId: advisorB, advisorLinkStatus: 'LINKED' });
    const tokens = await db.emailToken.findMany({ where: { userId: user.id } });
    expect(tokens.map((t) => t.purpose)).to.deep.equal(['STUDENT_INVITATION']);
    expect(JSON.stringify(tokens)).to.not.include('"token"');

    const events = await db.outboxEvent.findMany({ where: { aggregateId: user.id } });
    expect(events).to.have.length(1);
    expect(events[0].type).to.equal('AdvisorLinkChanged');
    expect(events[0].correlationId).to.equal(header['X-Correlation-Id']);
    expect(events[0].payload).to.include({ student_user_id: user.id, new_advisor_id: advisorB, link_status: 'LINKED', changed_by: 'ADVISOR' });
    expect(events[0].payload).to.not.have.property('old_advisor_id');
    const history = await db.statusHistory.findMany({ where: { entityId: user.id } });
    expect(history.map((h) => h.reason).sort()).to.deep.equal(['ADVISOR_LINK', 'STUDENT_CREATED_BY_ADVISOR']);
  });

  it('student code is unique per university in the DB: same code in another university is allowed, concurrent duplicates ⇒ 409', async () => {
    const code = studentCode();
    const first = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ student_code: code })).expect(201);
    const firstProfile = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: first.body.student_user_id }, include: { user: true } });
    expect(firstProfile.universityId).to.equal(firstProfile.user.universityId);

    // สถาบันอื่นใช้รหัสเดียวกันได้
    const other = await http().post('/v1/advisor-links/students').set(advisorAuth(outsider))
      .send(newStudent({ email: `o${randomBytes(3).toString('hex')}@other.ac.th`, student_code: code })).expect(201);
    expect((await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: other.body.student_user_id } })).universityId).to.not.equal(firstProfile.universityId);

    // constraint ระดับ DB (ข้ามการเช็กของ API)
    const err = await db.user.create({ data: { email: `raw${randomBytes(3).toString('hex')}@test.ac.th`, fullName: 'Raw', role: 'STUDENT', status: 'PENDING_EMAIL', universityId: firstProfile.universityId,
      studentProfile: { create: { universityId: firstProfile.universityId, studentCode: code, major: 'CS', yearLevel: 1 } } } }).then(() => null, (e: unknown) => e as { code?: string; meta?: { target?: unknown } });
    expect(err?.code).to.equal('P2002');
    expect(JSON.stringify(err?.meta?.target)).to.match(/student_?code/i);

    // คำขอพร้อมกันด้วยรหัสใหม่เดียวกัน: สำเร็จ 1 คำขอ ที่เหลือได้ 409 STUDENT_CODE_ALREADY_USED (ไม่ใช่ 500)
    const raced = studentCode();
    const results = await Promise.all(Array.from({ length: 6 }, () =>
      http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ student_code: raced }))));
    expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409, 409, 409, 409, 409]);
    for (const r of results.filter((x) => x.status === 409)) {
      expect(r.body.error.code).to.equal('STATE_CONFLICT');
      expect(r.body.error.details[0]).to.deep.equal({ field: 'student_code', issue: 'STUDENT_CODE_ALREADY_USED' });
    }
    expect(await db.studentProfileIdentity.count({ where: { studentCode: raced } })).to.equal(1);
  });

  it('create validations: domain, duplicate email/code, inactive advisor, wrong roles, bad body', async () => {
    const ok = newStudent();
    await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(ok).expect(201);
    const domain = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ email: 'x@other.ac.th' })).expect(400);
    expect(domain.body.error.details[0].issue).to.equal('EMAIL_DOMAIN_NOT_ALLOWED');
    await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ email: 'x@gmail.com' })).expect(400);
    const dupEmail = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ email: ok.email.toUpperCase() })).expect(409);
    expect(dupEmail.body.error.details[0].issue).to.equal('EMAIL_ALREADY_REGISTERED');
    const dupCode = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ student_code: ok.student_code })).expect(409);
    expect(dupCode.body.error.details[0].issue).to.equal('STUDENT_CODE_ALREADY_USED');
    for (const bad of [{ year_level: 0 }, { year_level: 11 }, { year_level: 'x' }, { major: '' }, { full_name: ' ' }, { email: 'not-an-email' }]) {
      await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent(bad)).expect(400);
    }
    // ปีอื่นที่ไม่ใช่ปี 4 ⇒ INTERN_YEAR_ONLY (ไม่สร้างบัญชี)
    for (const year_level of [1, 3, 5]) {
      const res = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ year_level })).expect(400);
      expect(res.body.error.details).to.deep.equal([{ field: 'year_level', issue: 'INTERN_YEAR_ONLY' }]);
    }
    // รูปแบบรหัสนักศึกษา: สั้น/ยาวเกิน, มีขีด/ช่องว่าง, ตัวอักษรนำหน้าเกิน 2, ภาษาไทย ⇒ STUDENT_CODE_FORMAT
    for (const student_code of ['12345', '12345678901234', '66-100100', '6610 0100', 'ABC123456', 'ก6610010', 'S001', '']) {
      const res = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent({ student_code })).expect(400);
      const issues = res.body.error.details.map((d: { issue: string }) => d.issue) as string[];
      expect(issues.some((issue) => issue === 'STUDENT_CODE_FORMAT' || issue === 'isNotEmpty'), student_code).to.equal(true);
    }
    // ตัวอักษรนำหน้าพิมพ์เล็ก/มีช่องว่างหัวท้าย ⇒ เก็บเป็น B + ตัวเลข
    const prefixed = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB))
      .send(newStudent({ student_code: ` b${randomInt(1_000_000, 9_999_999)} ` })).expect(201);
    const prefixedCode = (await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: prefixed.body.student_user_id } })).studentCode;
    expect(prefixedCode).to.match(/^B[0-9]{7}$/);
    const pending = await http().post('/v1/advisor-links/students').set(advisorAuth(advisorC)).send(newStudent()).expect(401); // ยังไม่อนุมัติ (api-contract §2: ACCOUNT_SUSPENDED = 401)
    expect(pending.body.error.code).to.equal('ACCOUNT_SUSPENDED');
    await http().post('/v1/advisor-links/students').set('Authorization', bearer(studentId, 'STUDENT')).send(newStudent()).expect(403);
    await http().post('/v1/advisor-links/students').send(newStudent()).expect(401);
    expect(await db.user.count({ where: { email: { startsWith: 'x@' } } })).to.equal(0);
  });

  it('simultaneous creates with the same email produce one account and one event', async () => {
    const body = newStudent();
    const results = await Promise.all([1, 2].map(() => http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(body)));
    expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409]);
    expect(await db.user.count({ where: { email: body.email } })).to.equal(1);
  });

  it('simultaneous creates with one student code in the same university produce one account', async () => {
    const code = studentCode();
    const results = await Promise.all([1, 2].map(() => http().post('/v1/advisor-links/students')
      .set(advisorAuth(advisorB)).send(newStudent({ student_code: code }))));
    expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409]);
    const advisor = await db.user.findUniqueOrThrow({ where: { id: advisorB } });
    expect(await db.studentProfileIdentity.count({ where: { studentCode: code,
      user: { universityId: advisor.universityId } } })).to.equal(1);
  });

  it('lists only own students with q / year_level / activation filters and invitation expiry for pending ones', async () => {
    const mine = await db.user.findMany({ where: { studentProfile: { is: { advisorId: advisorB } } }, include: { studentProfile: true } });
    await db.user.update({ where: { id: mine[0].id }, data: { status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: 'x' } });
    const code = mine[1].studentProfile!.studentCode;
    const all = await http().get('/v1/advisor-links/students?page_size=100').set(advisorAuth(advisorB)).expect(200);
    expect(all.body.meta.total).to.equal(mine.length);
    for (const row of all.body.data) {
      expect(row).to.include.keys('user_id', 'full_name', 'email', 'student_code', 'major', 'year_level', 'activation_status');
      if (row.activation_status === 'PENDING') expect(row.invitation_expires_at).to.be.a('string');
      else expect(row).to.not.have.property('invitation_expires_at');
    }
    expect((await http().get('/v1/advisor-links/students?activation=ACTIVE').set(advisorAuth(advisorB)).expect(200)).body.data.map((r: { user_id: string }) => r.user_id)).to.deep.equal([mine[0].id]);
    expect((await http().get('/v1/advisor-links/students?activation=PENDING&page_size=100').set(advisorAuth(advisorB)).expect(200)).body.meta.total).to.equal(mine.length - 1);
    expect((await http().get(`/v1/advisor-links/students?q=${code.toLowerCase()}`).set(advisorAuth(advisorB)).expect(200)).body.data.map((r: { student_code: string }) => r.student_code)).to.deep.equal([code]);
    expect((await http().get('/v1/advisor-links/students?year_level=9').set(advisorAuth(advisorB)).expect(200)).body.meta.total).to.equal(0);
    await http().get('/v1/advisor-links/students?activation=NOPE').set(advisorAuth(advisorB)).expect(400);
    await http().get('/v1/advisor-links/students?year_level=0').set(advisorAuth(advisorB)).expect(400);
    expect((await http().get('/v1/advisor-links/students').set(advisorAuth(advisorA)).expect(200)).body.meta.total).to.equal(0); // ไม่เห็นของอาจารย์อื่น
  });

  it('edit, resend (old link dies) and cancel only for the owning advisor and only before the password is set', async () => {
    const created = (await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent()).expect(201)).body;
    const id = created.student_user_id as string;
    await http().patch(`/v1/advisor-links/students/${id}`).set(advisorAuth(advisorA)).send({ major: 'X' }).expect(404);
    await http().patch(`/v1/advisor-links/students/${id}`).set(advisorAuth(advisorB)).send({ major: 'Data Science', year_level: 4, full_name: 'ชื่อใหม่' }).expect(204);
    const edited = await db.user.findUniqueOrThrow({ where: { id }, include: { studentProfile: true } });
    expect(edited.fullName).to.equal('ชื่อใหม่');
    expect(edited.studentProfile).to.include({ major: 'Data Science', yearLevel: 4 });
    await http().patch(`/v1/advisor-links/students/${id}`).set(advisorAuth(advisorB)).send({ major: ' ' }).expect(400);
    await http().patch(`/v1/advisor-links/students/${id}`).set(advisorAuth(advisorB)).send({ year_level: 99 }).expect(400);
    // รับเฉพาะปี 4 — แก้เป็นปีอื่นไม่ได้
    const year3 = await http().patch(`/v1/advisor-links/students/${id}`).set(advisorAuth(advisorB)).send({ year_level: 3 }).expect(400);
    expect(year3.body.error.details).to.deep.equal([{ field: 'year_level', issue: 'INTERN_YEAR_ONLY' }]);

    const before = await db.emailToken.findMany({ where: { userId: id } });
    await http().post(`/v1/advisor-links/students/${id}/actions/resend-invitation`).set(advisorAuth(advisorA)).expect(404);
    // Force a mail failure so the expected 503 does not depend on a running Mailpit or developer SMTP settings.
    const mailFailure = sinon.stub(app.get(AuthMailer), 'send').rejects(new Error('test SMTP failure'));
    try {
      await http().post(`/v1/advisor-links/students/${id}/actions/resend-invitation`).set(advisorAuth(advisorB)).expect(503);
    } finally { mailFailure.restore(); }
    const after = await db.emailToken.findMany({ where: { userId: id }, orderBy: { createdAt: 'asc' } });
    expect(after).to.have.length(before.length + 1);
    expect(after.filter((t) => !t.usedAt)).to.have.length(1); // ลิงก์เดิมใช้ไม่ได้

    await http().delete(`/v1/advisor-links/students/${id}/invitation`).set(advisorAuth(advisorA)).expect(404);
    await http().delete(`/v1/advisor-links/students/${id}/invitation`).set(advisorAuth(advisorB)).expect(204);
    const gone = await db.user.findUniqueOrThrow({ where: { id } });
    expect(gone).to.include({ status: 'DELETED' });
    expect(gone.email).to.match(/^deleted-.+@invalid\.example$/);
    expect(await db.studentProfileIdentity.count({ where: { userId: id } })).to.equal(0);
    expect(await db.emailToken.count({ where: { userId: id } })).to.equal(0);
    const last = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: id }, orderBy: { createdAt: 'desc' } });
    expect(last.payload).to.include({ link_status: 'UNLINKED', changed_by: 'ADVISOR', old_advisor_id: advisorB });
    await http().delete(`/v1/advisor-links/students/${id}/invitation`).set(advisorAuth(advisorB)).expect(404);
    expect(await db.user.count({ where: { email: created.email } })).to.equal(0); // อีเมลเดิมสร้างใหม่ได้

    // ตั้งรหัสผ่านแล้ว ⇒ ส่งซ้ำ/ยกเลิกไม่ได้
    const active = (await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent()).expect(201)).body.student_user_id as string;
    await db.user.update({ where: { id: active }, data: { status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: 'x' } });
    await http().post(`/v1/advisor-links/students/${active}/actions/resend-invitation`).set(advisorAuth(advisorB)).expect(409);
    await http().delete(`/v1/advisor-links/students/${active}/invitation`).set(advisorAuth(advisorB)).expect(409);
  });

  it('only Admin may change a student advisor (audit + event); advisor and student cannot', async () => {
    const s = (await http().post('/v1/advisor-links/students').set(advisorAuth(advisorB)).send(newStudent()).expect(201)).body.student_user_id as string;
    await http().post(`/v1/admin/students/${s}/advisor`).set(adminAuth()).send({ advisor_id: advisorA }).expect(409); // บัญชียังไม่ ACTIVE
    await db.user.update({ where: { id: s }, data: { status: 'ACTIVE', emailVerifiedAt: new Date(), passwordHash: 'x' } });
    await http().post(`/v1/admin/students/${s}/advisor`).set(advisorAuth(advisorB)).send({ advisor_id: advisorA }).expect(403);
    await http().post(`/v1/admin/students/${s}/advisor`).set('Authorization', bearer(s, 'STUDENT')).send({ advisor_id: advisorA }).expect(403);
    await http().post(`/v1/admin/students/${s}/advisor`).set(adminAuth()).send({ advisor_id: outsider }).expect(403);
    await http().post(`/v1/admin/students/${s}/advisor`).set(adminAuth()).send({ advisor_id: advisorB }).expect(409);
    await http().post(`/v1/admin/students/${s}/advisor`).set(adminAuth()).send({ advisor_id: advisorA }).expect(204);
    const moved = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: s } });
    expect(moved).to.include({ advisorId: advisorA, advisorLinkStatus: 'LINKED' });
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: s }, orderBy: { createdAt: 'desc' } });
    expect(event.payload).to.include({ changed_by: 'ADMIN', old_advisor_id: advisorB, new_advisor_id: advisorA, link_status: 'LINKED' });
    expect(await db.adminAuditLog.count({ where: { action: 'STUDENT_ADVISOR_MOVE', targetId: s } })).to.equal(1);
    expect((await http().get('/v1/advisor-links/students').set(advisorAuth(advisorB)).expect(200)).body.data.map((r: { user_id: string }) => r.user_id)).to.not.include(s);
  });

  it('Admin rejects pending advisor and records denylist, audit and suspension event', async () => {
    await http().post(`/v1/admin/advisors/${advisorC}/actions/reject`).set(adminAuth()).send({ reason: 'คุณสมบัติไม่ครบ' }).expect(204);
    expect((await db.user.findUniqueOrThrow({ where: { id: advisorC } })).status).to.equal('SUSPENDED');
    expect(await db.tokenDenylist.count({ where: { userId: advisorC } })).to.equal(1);
    expect(await db.outboxEvent.count({ where: { aggregateId: advisorC, type: 'UserSuspended' } })).to.equal(1);
    expect(await db.adminAuditLog.count({ where: { targetId: advisorC } })).to.equal(1);
  });

  it('GET /users/me of a student no longer exposes pending_advisor_id', async () => {
    const me = await http().get('/v1/users/me').set('Authorization', bearer(studentId, 'STUDENT')).expect(200);
    expect(me.body.student).to.not.have.property('pending_advisor_id');
  });
});
