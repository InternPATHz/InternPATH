import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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
import { AdvisorLinkModule } from '../../src/modules/advisor-links/advisor-link.module';
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

describe('Identity advisor link (Postgres จริง)', function () {
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
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), PrismaModule, StubMessagingModule, AdvisorLinkModule] }).compile();
    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    db = app.get(PrismaService);
    const uni = await db.university.create({ data: { name: 'Test University', emailDomain: 'test.ac.th' } });
    const otherUni = await db.university.create({ data: { name: 'Other University', emailDomain: 'other.ac.th' } });
    const user = await db.user.create({ data: { email: 'student@test.ac.th', passwordHash: 'test-only', fullName: 'Student', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId: uni.id,
      studentProfile: { create: { studentCode: 'S001', major: 'CS', yearLevel: 3 } } } });
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

  it('Admin approves advisor; student sees only active advisors from their university', async () => {
    const before = await request(app.getHttpServer()).get('/v1/advisors').set('Authorization', bearer(studentId, 'STUDENT')).expect(200);
    expect(before.body.data.map((item: { id: string }) => item.id)).to.deep.equal([advisorB]);
    const pending = await request(app.getHttpServer()).get('/v1/admin/advisors?status=PENDING_APPROVAL').set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).expect(200);
    expect(pending.body.meta.total).to.equal(2);
    await request(app.getHttpServer()).post(`/v1/admin/advisors/${advisorA}/actions/approve`).set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).send({}).expect(204);
    await request(app.getHttpServer()).post(`/v1/admin/advisors/${advisorA}/actions/approve`).set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).send({}).expect(409);
    const profile = await db.advisorProfile.findUniqueOrThrow({ where: { userId: advisorA } });
    expect(profile.approvedBy).to.equal(adminId);
    expect(await db.adminAuditLog.count({ where: { targetId: advisorA } })).to.equal(1);
    const after = await request(app.getHttpServer()).get('/v1/advisors?q=Advisor').set('Authorization', bearer(studentId, 'STUDENT')).expect(200);
    expect(after.body.meta.total).to.equal(2);
    expect(after.body.data.map((item: { id: string }) => item.id)).to.include.members([advisorA, advisorB]);
  });

  it('student request and advisor confirmation write outbox and keep history', async () => {
    const header = { 'X-Correlation-Id': randomUUID() };
    const first = await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', bearer(studentId, 'STUDENT')).set(header).send({ advisor_id: advisorA }).expect(201);
    expect(first.body).to.deep.equal({});
    expect(first.headers['x-correlation-id']).to.equal(header['X-Correlation-Id']);
    const me = await request(app.getHttpServer()).get('/v1/users/me').set('Authorization', bearer(studentId, 'STUDENT')).expect(200);
    expect(me.body.student.advisor_link_status).to.equal('ADVISOR_LINK_PENDING');
    expect(me.body.student.pending_advisor_id).to.equal(advisorA);
    const queue = await request(app.getHttpServer()).get('/v1/advisor-links/requests').set('Authorization', bearer(advisorA, 'ADVISOR')).expect(200);
    expect(queue.body.meta.total).to.equal(1);
    await request(app.getHttpServer()).post(`/v1/advisor-links/requests/${studentId}/actions/confirm`).set('Authorization', bearer(advisorA, 'ADVISOR')).expect(204);
    const linked = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: studentId } });
    expect(linked.advisorId).to.equal(advisorA);
    expect(linked.advisorLinkStatus).to.equal('LINKED');
    const events = await db.outboxEvent.findMany({ where: { aggregateId: studentId }, orderBy: { createdAt: 'asc' } });
    expect(events.map((event) => event.type)).to.deep.equal(['AdvisorLinkChanged', 'AdvisorLinkChanged']);
    expect((events[1].payload as { new_advisor_id: string }).new_advisor_id).to.equal(advisorA);
    const requested = events.find((event) => (event.payload as { link_status: string }).link_status === 'ADVISOR_LINK_PENDING');
    expect(requested?.correlationId).to.equal(header['X-Correlation-Id']);
    expect(await db.statusHistory.count({ where: { entityId: studentId } })).to.equal(2);
    const history = await db.statusHistory.findMany({ where: { entityId: studentId }, orderBy: { occurredAt: 'asc' } });
    expect(history.map((entry) => entry.actorId)).to.deep.equal([studentId, advisorA]);
  });

  it('switches advisors only after the new advisor confirms', async () => {
    const universityId = (await db.user.findUniqueOrThrow({ where: { id: studentId } })).universityId!;
    const switchingStudent = await db.user.create({ data: { email: 'switch@test.ac.th', passwordHash: 'test-only', fullName: 'Switch Student', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId,
      studentProfile: { create: { studentCode: 'S003', major: 'CS', yearLevel: 3 } } } });
    const token = bearer(switchingStudent.id, 'STUDENT');
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', token).send({ advisor_id: advisorA }).expect(201);
    await request(app.getHttpServer()).post(`/v1/advisor-links/requests/${switchingStudent.id}/actions/confirm`).set('Authorization', bearer(advisorA, 'ADVISOR')).expect(204);
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', token).send({ advisor_id: advisorB }).expect(201);
    const pending = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: switchingStudent.id } });
    expect(pending.advisorId).to.equal(advisorA);
    expect(pending.pendingAdvisorId).to.equal(advisorB);
    await request(app.getHttpServer()).post(`/v1/advisor-links/requests/${switchingStudent.id}/actions/confirm`).set('Authorization', bearer(advisorB, 'ADVISOR')).expect(204);
    const linked = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: switchingStudent.id } });
    expect(linked.advisorId).to.equal(advisorB);
    expect(linked.pendingAdvisorId).to.equal(null);
    const event = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: switchingStudent.id }, orderBy: { createdAt: 'desc' } });
    expect(event.payload).to.include({ link_status: 'LINKED', old_advisor_id: advisorA, new_advisor_id: advisorB, changed_by: 'ADVISOR' });
  });

  it('change request keeps previous advisor; rejection restores linked state; Admin may move', async () => {
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', bearer(studentId, 'STUDENT')).send({ advisor_id: advisorB }).expect(201);
    const pending = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: studentId } });
    expect(pending.advisorId).to.equal(advisorA);
    expect(pending.pendingAdvisorId).to.equal(advisorB);
    const students = await request(app.getHttpServer()).get('/v1/advisor-links/students').set('Authorization', bearer(advisorA, 'ADVISOR')).expect(200);
    expect(students.body.meta.total).to.equal(1);
    await request(app.getHttpServer()).post(`/v1/advisor-links/requests/${studentId}/actions/reject`).set('Authorization', bearer(advisorB, 'ADVISOR')).expect(204);
    const restored = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: studentId } });
    expect(restored.advisorId).to.equal(advisorA);
    expect(restored.advisorLinkStatus).to.equal('LINKED');
    await request(app.getHttpServer()).post(`/v1/admin/students/${studentId}/advisor`).set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).send({ advisor_id: advisorB }).expect(204);
    const moved = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: studentId } });
    expect(moved.advisorId).to.equal(advisorB);
    expect((await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: studentId }, orderBy: { createdAt: 'desc' } })).payload).to.include({ changed_by: 'ADMIN', old_advisor_id: advisorA, new_advisor_id: advisorB });
    expect(await db.adminAuditLog.count({ where: { action: 'STUDENT_ADVISOR_MOVE' } })).to.equal(1);
  });

  it('student may cancel a pending change without losing the current advisor', async () => {
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', bearer(studentId, 'STUDENT')).send({ advisor_id: advisorA }).expect(201);
    await request(app.getHttpServer()).delete('/v1/users/me/advisor-link').set('Authorization', bearer(studentId, 'STUDENT')).expect(204);
    const profile = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: studentId } });
    expect(profile.advisorId).to.equal(advisorB);
    expect(profile.pendingAdvisorId).to.equal(null);
    expect(profile.advisorLinkStatus).to.equal('LINKED');
    const latest = await db.outboxEvent.findFirstOrThrow({ where: { aggregateId: studentId }, orderBy: { createdAt: 'desc' } });
    expect(latest.payload).to.include({ link_status: 'LINKED', new_advisor_id: advisorB, changed_by: 'STUDENT' });
  });

  it('rejects cross-university, pending advisor, wrong role and repeated action', async () => {
    const studentToken = bearer(studentId, 'STUDENT');
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', studentToken).send({ advisor_id: outsider }).expect(403);
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', studentToken).send({ advisor_id: advisorC }).expect(409);
    await request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', bearer(advisorB, 'ADVISOR')).send({ advisor_id: advisorA }).expect(403);
    await request(app.getHttpServer()).post(`/v1/advisor-links/requests/${studentId}/actions/confirm`).set('Authorization', bearer(advisorA, 'ADVISOR')).expect(409);
  });

  it('Admin rejects pending advisor and records denylist, audit and suspension event', async () => {
    await request(app.getHttpServer()).post(`/v1/admin/advisors/${advisorC}/actions/reject`).set('Authorization', bearer(adminId, 'PLATFORM_ADMIN')).send({ reason: 'คุณสมบัติไม่ครบ' }).expect(204);
    expect((await db.user.findUniqueOrThrow({ where: { id: advisorC } })).status).to.equal('SUSPENDED');
    expect(await db.tokenDenylist.count({ where: { userId: advisorC } })).to.equal(1);
    expect(await db.outboxEvent.count({ where: { aggregateId: advisorC, type: 'UserSuspended' } })).to.equal(1);
    expect(await db.adminAuditLog.count({ where: { targetId: advisorC } })).to.equal(1);
  });

  it('two simultaneous student requests create only one pending link and one event', async () => {
    const universityId = (await db.user.findUniqueOrThrow({ where: { id: studentId } })).universityId!;
    const second = await db.user.create({ data: { email: 'second@test.ac.th', passwordHash: 'test-only', fullName: 'Second Student', role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId,
      studentProfile: { create: { studentCode: 'S002', major: 'CS', yearLevel: 2 } } } });
    const token = bearer(second.id, 'STUDENT');
    const results = await Promise.all([advisorA, advisorB].map((advisorId) =>
      request(app.getHttpServer()).post('/v1/users/me/advisor-link').set('Authorization', token).send({ advisor_id: advisorId }),
    ));
    expect(results.map((result) => result.status).sort()).to.deep.equal([201, 409]);
    const profile = await db.studentProfileIdentity.findUniqueOrThrow({ where: { userId: second.id } });
    expect([advisorA, advisorB]).to.include(profile.pendingAdvisorId);
    expect(await db.outboxEvent.count({ where: { aggregateId: second.id, type: 'AdvisorLinkChanged' } })).to.equal(1);
  });
});
