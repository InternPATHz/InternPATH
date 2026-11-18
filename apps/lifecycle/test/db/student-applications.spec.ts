import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { ApplicationsModule } from '../../src/modules/applications/applications.module';
import { ProblemReportsModule } from '../../src/modules/problem-reports/problem-reports.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { bangkokToday } from '../../src/state-machine/dates';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity } from '../support/profile-resume-fakes';

/** OutboxWriter มาจาก MessagingModule (Global) ในแอปจริง — เทสต์ไม่ต่อ RabbitMQ จึงให้ตัวเขียนตรง */
@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class OutboxOnlyModule {}

const DAY_MS = 86_400_000;
const ymd = (d: Date) => d.toISOString().slice(0, 10);

/*
 * หัวข้อ 1.4 — ใบสมัครฝั่งนักศึกษา (api-contract §7.2) ผ่าน HTTP จริง + Postgres จริง + State Machine จริง
 * Identity/Job เป็นตัวปลอม (Job ยังไม่มี Internal API) • ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle 1.4 — ใบสมัครฝั่งนักศึกษา (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  const identity = new FakeIdentity();
  const job = new FakeJobClient();
  const http = () => request(app.getHttpServer());

  const advisorId = randomUUID();
  let student: string;
  let companyId: string;
  let resumeId: string;

  const asStudent = (sub = student) => bearer({ role: 'STUDENT', sub });
  const asHr = () => bearer({ role: 'COMPANY_HR', sub: randomUUID(), company_id: companyId, company_role: 'MEMBER' });

  before(async function () {
    database = await createTestDatabase('lc_apply');
    if (!database) this.skip();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_PUBLIC_KEY: TEST_JWT.publicKey, LIFECYCLE_DATABASE_URL: database!.url })],
        }),
        PrismaModule,
        LifecycleConfigModule,
        InternalModule,
        OutboxOnlyModule,
        ApplicationsModule,
        ProblemReportsModule,
      ],
    })
      .overrideProvider(IdentityInternalClient)
      .useValue(identity)
      .overrideProvider(JobInternalClient)
      .useValue(job)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    job.reset();
    identity.students.clear();
    identity.consents.clear();
    identity.unavailable = false;
    // นักศึกษา/บริษัทใหม่ทุกเทสต์ ⇒ ไม่ต้องล้างตาราง (status_history เป็น append-only)
    student = randomUUID();
    companyId = randomUUID();
    identity.setStudent(student, {
      major: 'วิศวกรรมคอมพิวเตอร์',
      email_verified: true,
      advisor_link_status: 'LINKED',
      advisor_id: advisorId,
    });
    identity.consents.add(`${student}:${companyId}`);
    await prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท ทดสอบ จำกัด', status: 'VERIFIED' } });
    resumeId = (
      await prisma.resume.create({
        data: { studentUserId: student, objectKey: `resumes/${randomUUID()}.pdf`, sizeBytes: 1000, isPrimary: true },
      })
    ).id;
  });

  /** ประกาศเปิดรับของบริษัทในเทสต์ (+ job_snapshot สำหรับชื่อประกาศ) */
  const openJob = async (data: Parameters<FakeJobClient['addJob']>[0] = {}) => {
    const created = job.addJob({ company_id: companyId, ...data });
    await prisma.jobSnapshot.create({
      data: { jobId: created.job_id, companyId: created.company_id, status: created.status, title: 'นักศึกษาฝึกงาน Backend' },
    });
    return created;
  };

  const apply = (jobId: string, overrides: Record<string, unknown> = {}, token = asStudent()) =>
    http()
      .post('/v1/applications')
      .set('Authorization', token)
      .send({ job_id: jobId, resume_id: resumeId, consent: true, ...overrides });

  /** ใส่ใบสมัครตรง (ข้าม API) เพื่อตั้งสถานะเริ่มต้นของเทสต์ action */
  const seed = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
    prisma.application.create({
      data: {
        jobId: randomUUID(),
        companyId,
        studentUserId: student,
        advisorUserId: advisorId,
        resumeId,
        status,
        ...data,
      },
    });

  const action = (id: string, name: string, body: Record<string, unknown> = {}, token = asStudent()) =>
    http().post(`/v1/applications/${id}/actions/${name}`).set('Authorization', token).send(body);

  const outboxOf = (aggregateId: string) =>
    prisma.outboxEvent.findMany({ where: { aggregateId }, orderBy: { createdAt: 'asc' } });

  // ------------------------------------------------------------------
  describe('Guard สิทธิ์ (UAT-29)', () => {
    it('ไม่มี Token ⇒ 401 • Role อื่น ⇒ 403 FORBIDDEN_ROLE ทุก endpoint ของ §7.2', async () => {
      const id = randomUUID();
      const endpoints: Array<[string, string]> = [
        ['post', '/v1/applications'],
        ['get', '/v1/me/applications'],
        ['get', `/v1/me/applications/${id}`],
        ['get', '/v1/me/application-eligibility'],
        ['post', `/v1/applications/${id}/actions/confirm-offer`],
        ['post', `/v1/applications/${id}/actions/decline-offer`],
        ['post', `/v1/applications/${id}/actions/withdraw`],
        ['post', `/v1/applications/${id}/actions/request-termination`],
        ['post', `/v1/applications/${id}/actions/dispute-fail`],
        ['post', `/v1/applications/${id}/problem-reports`],
      ];
      for (const [method, path] of endpoints) {
        const anon = await (http() as any)[method](path);
        expect(anon.status, `anon ${path}`).to.equal(401);
        for (const token of [asHr(), bearer({ role: 'ADVISOR', sub: advisorId }), bearer({ role: 'PLATFORM_ADMIN' })]) {
          const res = await (http() as any)[method](path).set('Authorization', token);
          expect(res.status, `${method} ${path}`).to.equal(403);
          expect(res.body.error.code).to.equal('FORBIDDEN_ROLE');
        }
      }
    });

    it('ใบสมัครของนักศึกษาคนอื่น ⇒ 404 NOT_FOUND (ดูรายละเอียด / action / รายงานปัญหา)', async () => {
      const mine = await seed('IN_PROGRESS');
      const other = asStudent(randomUUID());
      expect((await http().get(`/v1/me/applications/${mine.id}`).set('Authorization', other)).status).to.equal(404);
      expect((await action(mine.id, 'request-termination', { reason: 'x' }, other)).status).to.equal(404);
      const report = await http()
        .post(`/v1/applications/${mine.id}/problem-reports`)
        .set('Authorization', other)
        .send({ category: 'OTHER', detail: 'x' });
      expect(report.status).to.equal(404);
      expect((await prisma.application.findUniqueOrThrow({ where: { id: mine.id } })).status).to.equal('IN_PROGRESS');
    });
  });

  // ------------------------------------------------------------------
  describe('POST /applications', () => {
    it('สร้าง PENDING + status_history (from = null) + E08 ไม่มี from_status', async () => {
      const posting = await openJob({ target_majors: ['วิศวกรรมคอมพิวเตอร์'] });
      const res = await apply(posting.job_id, { cover_letter: '  สนใจตำแหน่งนี้  ' }).expect(201);
      expect(res.body).to.include({
        job_id: posting.job_id,
        job_title: 'นักศึกษาฝึกงาน Backend',
        company_id: companyId,
        company_name: 'บริษัท ทดสอบ จำกัด',
        status: 'PENDING',
        major_mismatch: false,
        frozen: false,
      });

      const row = await prisma.application.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(row).to.include({ studentUserId: student, advisorUserId: advisorId, resumeId, resumeConsentId: null });
      expect(row.coverLetter).to.equal('สนใจตำแหน่งนี้');
      expect(row.quotaReserved).to.equal(false);

      const history = await prisma.statusHistory.findMany({ where: { entityId: row.id } });
      expect(history).to.have.length(1);
      expect(history[0]).to.include({ entity: 'APPLICATION', fromStatus: null, toStatus: 'PENDING', actorRole: 'STUDENT', actorId: student });

      const events = await outboxOf(row.id);
      expect(events).to.have.length(1);
      expect(events[0].type).to.equal('ApplicationStatusChanged');
      const payload = events[0].payload as Record<string, unknown>;
      expect(payload).to.not.have.property('from_status');
      expect(payload).to.include({
        application_id: row.id,
        student_user_id: student,
        advisor_user_id: advisorId,
        to_status: 'PENDING',
        actor_role: 'STUDENT',
        actor_user_id: student,
      });
      // ไม่จองโควตาตอนสมัคร (จองตอน HR ตอบรับ)
      expect(job.calls).to.deep.equal([]);
    });

    it('major_mismatch = true เมื่อสาขาไม่อยู่ใน target_majors (ไม่บล็อกการสมัคร)', async () => {
      const posting = await openJob({ target_majors: ['บัญชี', 'การตลาด'] });
      const res = await apply(posting.job_id).expect(201);
      expect(res.body.major_mismatch).to.equal(true);
    });

    it('ไม่ติ๊ก consent ⇒ 403 CONSENT_REQUIRED (UAT-29 ข้อ 4) และไม่ถาม Identity/Job', async () => {
      const posting = await openJob();
      identity.unavailable = true;
      const res = await apply(posting.job_id, { consent: false }).expect(403);
      expect(res.body.error.code).to.equal('CONSENT_REQUIRED');
      expect(res.body.error.details[0].issue).to.equal('CONSENT_NOT_ACCEPTED');
      expect(await prisma.application.count({ where: { studentUserId: student } })).to.equal(0);
    });

    it('ไม่มี Consent ที่ Identity ⇒ 403 CONSENT_REQUIRED (CONSENT_NOT_RECORDED)', async () => {
      const posting = await openJob();
      identity.consents.clear();
      const res = await apply(posting.job_id).expect(403);
      expect(res.body.error.details[0].issue).to.equal('CONSENT_NOT_RECORDED');
    });

    it('อีเมลยังไม่ยืนยัน ⇒ 401 EMAIL_NOT_VERIFIED • ยังไม่ผูกอาจารย์ ⇒ 403 ADVISOR_NOT_LINKED', async () => {
      const posting = await openJob();
      identity.setStudent(student, { email_verified: false, advisor_link_status: 'LINKED', advisor_id: advisorId });
      expect((await apply(posting.job_id).expect(401)).body.error.code).to.equal('EMAIL_NOT_VERIFIED');

      identity.setStudent(student, { email_verified: true, advisor_link_status: 'ADVISOR_LINK_PENDING', advisor_id: advisorId });
      expect((await apply(posting.job_id).expect(403)).body.error.code).to.equal('ADVISOR_NOT_LINKED');
    });

    it('ประกาศไม่ PUBLISHED / CLOSED / เลย deadline ⇒ 409 STATE_CONFLICT พร้อม issue • วัน deadline ยังสมัครได้', async () => {
      const cases: Array<[Parameters<FakeJobClient['addJob']>[0], string]> = [
        [{ status: 'VERIFYING' }, 'JOB_NOT_PUBLISHED'],
        [{ status: 'SUSPENDED' }, 'JOB_NOT_PUBLISHED'],
        [{ status: 'CLOSED' }, 'JOB_CLOSED'],
        [{ application_deadline: ymd(new Date(bangkokToday(new Date()).getTime() - DAY_MS)) }, 'DEADLINE_PASSED'],
      ];
      for (const [data, issue] of cases) {
        const posting = await openJob(data);
        const res = await apply(posting.job_id).expect(409);
        expect(res.body.error.code).to.equal('STATE_CONFLICT');
        expect(res.body.error.details[0].issue, issue).to.equal(issue);
      }
      const lastDay = await openJob({ application_deadline: ymd(bangkokToday(new Date())) });
      await apply(lastDay.job_id).expect(201);
    });

    it('บริษัทไม่ VERIFIED (ถูกระงับ / ยังไม่มี snapshot) ⇒ 403 COMPANY_NOT_VERIFIED', async () => {
      const posting = await openJob();
      await prisma.companySnapshot.update({ where: { companyId }, data: { status: 'SUSPENDED' } });
      expect((await apply(posting.job_id).expect(403)).body.error.code).to.equal('COMPANY_NOT_VERIFIED');

      const unknownCompany = job.addJob({ company_id: randomUUID() });
      identity.consents.add(`${student}:${unknownCompany.company_id}`);
      expect((await apply(unknownCompany.job_id).expect(403)).body.error.code).to.equal('COMPANY_NOT_VERIFIED');
    });

    it('ไม่มีประกาศ ⇒ 404 (job_id) • เรซูเม่ของคนอื่น/ถูกลบ ⇒ 404 (resume_id) • Job ล่ม ⇒ 502', async () => {
      const missing = await apply(randomUUID()).expect(404);
      expect(missing.body.error.details[0]).to.deep.equal({ field: 'job_id', issue: 'NOT_FOUND' });

      const posting = await openJob();
      const othersResume = await prisma.resume.create({
        data: { studentUserId: randomUUID(), objectKey: `resumes/${randomUUID()}.pdf`, sizeBytes: 1 },
      });
      expect((await apply(posting.job_id, { resume_id: othersResume.id }).expect(404)).body.error.details[0].field).to.equal(
        'resume_id',
      );
      await prisma.resume.update({ where: { id: resumeId }, data: { deletedAt: new Date() } });
      await apply(posting.job_id).expect(404);

      await prisma.resume.update({ where: { id: resumeId }, data: { deletedAt: null } });
      job.unavailable = true;
      expect((await apply(posting.job_id).expect(502)).body.error.code).to.equal('UPSTREAM_UNAVAILABLE');
    });

    it('body ไม่ถูกต้อง ⇒ 400 VALIDATION_FAILED (uuid ผิด, ไม่มี consent, ฟิลด์เกิน)', async () => {
      const posting = await openJob();
      for (const body of [
        { job_id: 'nope', resume_id: resumeId, consent: true },
        { job_id: posting.job_id, resume_id: resumeId },
        { job_id: posting.job_id, resume_id: resumeId, consent: true, status: 'COMPLETED' },
        { job_id: posting.job_id, resume_id: resumeId, consent: true, cover_letter: 'ก'.repeat(5001) },
      ]) {
        const res = await http().post('/v1/applications').set('Authorization', asStudent()).send(body);
        expect(res.status, JSON.stringify(body).slice(0, 80)).to.equal(400);
        expect(res.body.error.code).to.equal('VALIDATION_FAILED');
      }
    });

    it('สมัครซ้ำประกาศเดิมที่ยังดำเนินอยู่ ⇒ 409 ALREADY_APPLIED • ถอนแล้วสมัครใหม่ได้', async () => {
      const posting = await openJob();
      const first = await apply(posting.job_id).expect(201);
      expect((await apply(posting.job_id).expect(409)).body.error.code).to.equal('ALREADY_APPLIED');
      await action(first.body.id, 'withdraw').expect(200);
      await apply(posting.job_id).expect(201);
    });

    it('ยิงสมัครประกาศเดิมพร้อมกัน ⇒ สำเร็จ 1 ใบ อีกใบ 409 ALREADY_APPLIED (partial unique index)', async () => {
      const posting = await openJob();
      const results = await Promise.all([apply(posting.job_id), apply(posting.job_id), apply(posting.job_id)]);
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).to.deep.equal([201, 409, 409]);
      for (const r of results.filter((x) => x.status === 409)) expect(r.body.error.code).to.equal('ALREADY_APPLIED');
      expect(await prisma.application.count({ where: { studentUserId: student, jobId: posting.job_id } })).to.equal(1);
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-40 — บล็อกสมัครหลัง ACADEMIC_PASS + ปลดล็อกโดย Admin', () => {
    it('ผ่านวิชาแล้ว ⇒ eligibility ปิด + 403 REAPPLY_BLOCKED; ปลดล็อก 1 ครั้ง = สมัครได้ 1 ใบ', async () => {
      const passedAt = new Date(Date.now() - 10 * DAY_MS);
      await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS', academicRecordedAt: passedAt });
      const posting = await openJob();
      const posting2 = await openJob();

      const blocked = await http().get('/v1/me/application-eligibility').set('Authorization', asStudent()).expect(200);
      expect(blocked.body).to.deep.equal({ can_apply: false, blocked_reason: 'REAPPLY_BLOCKED' });
      expect((await apply(posting.job_id).expect(403)).body.error.code).to.equal('REAPPLY_BLOCKED');

      const unlock = await prisma.reapplyUnlock.create({
        data: { studentUserId: student, unlockedBy: randomUUID(), reason: 'ลงทะเบียนวิชาเลือกเพิ่ม' },
      });
      const open = await http().get('/v1/me/application-eligibility').set('Authorization', asStudent()).expect(200);
      expect(open.body).to.deep.equal({ can_apply: true });

      await apply(posting.job_id).expect(201);
      expect((await prisma.reapplyUnlock.findUniqueOrThrow({ where: { id: unlock.id } })).usedAt).to.be.instanceOf(Date);
      expect((await apply(posting2.job_id).expect(403)).body.error.code).to.equal('REAPPLY_BLOCKED');
    });

    it('ACADEMIC_FAIL / REPEAT_REQUIRED ไม่บล็อก • eligibility บอกเหตุผลฝั่ง Identity', async () => {
      await seed('COMPLETED', { academicResult: 'REPEAT_REQUIRED', academicRecordedAt: new Date() });
      await apply((await openJob()).job_id).expect(201);

      identity.setStudent(student, { email_verified: false, advisor_link_status: 'NONE' });
      const res = await http().get('/v1/me/application-eligibility').set('Authorization', asStudent()).expect(200);
      expect(res.body).to.deep.equal({ can_apply: false, blocked_reason: 'EMAIL_NOT_VERIFIED' });
    });
  });

  // ------------------------------------------------------------------
  describe('GET /me/applications และ /me/applications/{id}', () => {
    it('รายการเฉพาะของตน + กรอง status + pagination', async () => {
      const a = await apply((await openJob()).job_id).expect(201);
      await apply((await openJob()).job_id).expect(201);
      await action(a.body.id, 'withdraw').expect(200);
      await prisma.application.create({ data: { jobId: randomUUID(), companyId, studentUserId: randomUUID(), status: 'PENDING' } });

      const all = await http().get('/v1/me/applications?page_size=1').set('Authorization', asStudent()).expect(200);
      expect(all.body.meta).to.deep.equal({ page: 1, page_size: 1, total: 2 });
      expect(all.body.data).to.have.length(1);

      const withdrawn = await http().get('/v1/me/applications?status=WITHDRAWN').set('Authorization', asStudent()).expect(200);
      expect(withdrawn.body.data.map((x: any) => x.id)).to.deep.equal([a.body.id]);

      await http().get('/v1/me/applications?status=NOPE').set('Authorization', asStudent()).expect(400);
    });

    it('รายการมี academic_result เมื่ออาจารย์บันทึกแล้ว (ป้าย COMPLETED ผ่าน/ไม่ผ่าน — PM ขอ 18 พ.ย.)', async () => {
      const failed = await seed('COMPLETED', { academicResult: 'REPEAT_REQUIRED', academicRecordedAt: new Date() });
      const open = await seed('PENDING', { jobId: randomUUID() });
      const res = await http().get('/v1/me/applications').set('Authorization', asStudent()).expect(200);
      const byId = new Map(res.body.data.map((r: { id: string }) => [r.id, r]));
      expect(byId.get(failed.id)).to.include({ status: 'COMPLETED', academic_result: 'REPEAT_REQUIRED' });
      expect(byId.get(open.id)).to.not.have.property('academic_result');
    });

    it('รายละเอียด: timeline จาก status_history + available_actions ตามสถานะ', async () => {
      const created = await apply((await openJob()).job_id).expect(201);
      const pending = await http().get(`/v1/me/applications/${created.body.id}`).set('Authorization', asStudent()).expect(200);
      expect(pending.body.available_actions).to.deep.equal(['withdraw']);
      expect(pending.body.timeline).to.have.length(1);
      expect(pending.body.timeline[0]).to.not.have.property('from_status');
      expect(pending.body.timeline[0]).to.include({ to_status: 'PENDING', actor_role: 'STUDENT' });

      const offer = await seed('HR_ACCEPTED', { startDate: new Date('2027-01-04'), endDate: new Date('2027-03-04') });
      const detail = await http().get(`/v1/me/applications/${offer.id}`).set('Authorization', asStudent()).expect(200);
      expect(detail.body.available_actions).to.have.members(['confirm-offer', 'decline-offer']);
      expect(detail.body).to.include({ start_date: '2027-01-04', end_date: '2027-03-04' });
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-16 — สมัคร 3 ที่ ยืนยันได้ที่เดียว', () => {
    it('confirm-offer ⇒ ADVISOR_PENDING; ข้อเสนออื่น → STUDENT_DECLINED + release; ใบ PENDING ไม่ถูกแตะ', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) ids.push((await apply((await openJob()).job_id).expect(201)).body.id);
      // HR สองบริษัทตอบรับ (จำลองผล accept ของ 1.5)
      for (const id of ids.slice(0, 2)) {
        await prisma.application.update({
          where: { id },
          data: { status: 'HR_ACCEPTED', quotaReserved: true, startDate: new Date('2027-01-04'), endDate: new Date('2027-03-04') },
        });
      }

      const res = await action(ids[0], 'confirm-offer').expect(200);
      expect(res.body.status).to.equal('ADVISOR_PENDING');
      expect(res.body.available_actions).to.deep.equal(['withdraw']);

      const rows = await prisma.application.findMany({ where: { id: { in: ids } } });
      const status = (id: string) => rows.find((r) => r.id === id)!.status;
      expect([status(ids[0]), status(ids[1]), status(ids[2])]).to.deep.equal(['ADVISOR_PENDING', 'STUDENT_DECLINED', 'PENDING']);
      expect(job.releasedFor(ids[1])).to.equal(true);
      expect(job.releasedFor(ids[0])).to.equal(false);

      const declinedHistory = await prisma.statusHistory.findFirstOrThrow({ where: { entityId: ids[1], toStatus: 'STUDENT_DECLINED' } });
      expect(declinedHistory.actorRole).to.equal('SYSTEM');
      expect((await action(ids[1], 'confirm-offer').expect(409)).body.error.code).to.equal('STATE_CONFLICT');
    });

    it('ยืนยันที่อื่นอยู่แล้ว ⇒ 403 ALREADY_CONFIRMED_ELSEWHERE', async () => {
      await seed('IN_PROGRESS');
      const offer = await seed('HR_ACCEPTED', { quotaReserved: true });
      expect((await action(offer.id, 'confirm-offer').expect(403)).body.error.code).to.equal('ALREADY_CONFIRMED_ELSEWHERE');
    });

    it('decline-offer ⇒ STUDENT_DECLINED + release โควตา', async () => {
      const offer = await seed('HR_ACCEPTED', { quotaReserved: true });
      const res = await action(offer.id, 'decline-offer').expect(200);
      expect(res.body.status).to.equal('STUDENT_DECLINED');
      expect(job.releasedFor(offer.id)).to.equal(true);
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-33 — ถอนใบสมัคร', () => {
    it('PENDING ⇒ WITHDRAWN (ไม่เรียกโควตา) เก็บเหตุผล', async () => {
      const app1 = await seed('PENDING');
      const res = await action(app1.id, 'withdraw', { reason: 'ได้ที่อื่นแล้ว' }).expect(200);
      expect(res.body.status).to.equal('WITHDRAWN');
      expect(res.body.timeline.at(-1)).to.include({ from_status: 'PENDING', to_status: 'WITHDRAWN', reason: 'ได้ที่อื่นแล้ว' });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: app1.id } })).withdrawnReason).to.equal('ได้ที่อื่นแล้ว');
      expect(job.calls).to.deep.equal([]);
    });

    it('ADVISOR_PENDING / ADVISOR_APPROVED ⇒ WITHDRAWN + release; E08 มี from_status', async () => {
      for (const status of ['ADVISOR_PENDING', 'ADVISOR_APPROVED'] as const) {
        student = randomUUID(); // ยืนยันได้ทีละ 1 ที่ต่อคน
        const row = await seed(status, { quotaReserved: true });
        await action(row.id, 'withdraw').expect(200);
        expect(job.releasedFor(row.id), status).to.equal(true);
        const [event] = await outboxOf(row.id);
        expect((event.payload as any).from_status).to.equal(status);
        expect((event.payload as any).to_status).to.equal('WITHDRAWN');
      }
    });

    it('IN_PROGRESS ถอนไม่ได้ ⇒ 409 STATE_CONFLICT (ต้องใช้ request-termination)', async () => {
      const row = await seed('IN_PROGRESS');
      expect((await action(row.id, 'withdraw').expect(409)).body.error.code).to.equal('STATE_CONFLICT');
    });
  });

  // ------------------------------------------------------------------
  describe('request-termination และ dispute-fail', () => {
    it('request-termination ต้องมีเหตุผล ⇒ TERMINATED, terminated_by = STUDENT', async () => {
      const row = await seed('IN_PROGRESS', { actualStartDate: new Date('2026-10-01') });
      expect((await action(row.id, 'request-termination', { reason: '   ' }).expect(400)).body.error.code).to.equal('REASON_REQUIRED');

      const res = await action(row.id, 'request-termination', { reason: 'ถูกใช้งานนอกขอบเขต' }).expect(200);
      expect(res.body).to.include({ status: 'TERMINATED', terminated_by: 'STUDENT', terminate_reason: 'ถูกใช้งานนอกขอบเขต' });
      expect(res.body.actual_end_date).to.equal(ymd(bangkokToday(new Date())));
      const [event] = await outboxOf(row.id);
      expect(event.payload).to.include({ to_status: 'TERMINATED', terminated_by: 'STUDENT' });
    });

    it('dispute-fail ภายใน 7 วัน ⇒ FAIL_DISPUTED + fail_disputes (คำโต้แย้งไม่อยู่ใน E08/history)', async () => {
      const row = await seed('EVALUATED_FAIL');
      await prisma.evaluation.create({
        data: { applicationId: row.id, round: 1, result: 'FAIL', reason: 'ขาดงานบ่อย', evaluatedBy: randomUUID(), evaluatedAt: new Date(Date.now() - 2 * DAY_MS) },
      });
      const statement = 'มีใบรับรองแพทย์ทุกวันที่ขาด';
      const res = await action(row.id, 'dispute-fail', { statement }).expect(200);
      expect(res.body.status).to.equal('FAIL_DISPUTED');

      const disputes = await prisma.failDispute.findMany({ where: { applicationId: row.id } });
      expect(disputes).to.have.length(1);
      expect(disputes[0]).to.include({ statement, createdBy: student });
      const [event] = await outboxOf(row.id);
      expect(JSON.stringify(event.payload)).to.not.include(statement);
      const history = await prisma.statusHistory.findFirstOrThrow({ where: { entityId: row.id } });
      expect(history.reason).to.equal(null);
    });

    it('dispute-fail เลย 7 วัน ⇒ 422 DISPUTE_WINDOW_CLOSED • ไม่มีคำโต้แย้ง ⇒ 400 VALIDATION_FAILED', async () => {
      const row = await seed('EVALUATED_FAIL');
      await prisma.evaluation.create({
        data: { applicationId: row.id, round: 1, result: 'FAIL', reason: 'x', evaluatedBy: randomUUID(), evaluatedAt: new Date(Date.now() - 8 * DAY_MS) },
      });
      expect((await action(row.id, 'dispute-fail', { statement: '' }).expect(400)).body.error.code).to.equal('VALIDATION_FAILED');
      expect((await action(row.id, 'dispute-fail', { statement: 'ขอโต้แย้ง' }).expect(422)).body.error.code).to.equal(
        'DISPUTE_WINDOW_CLOSED',
      );
      expect(await prisma.failDispute.count({ where: { applicationId: row.id } })).to.equal(0);
    });
  });

  // ------------------------------------------------------------------
  describe('POST /applications/{id}/problem-reports', () => {
    const report = (id: string, body: Record<string, unknown>) =>
      http().post(`/v1/applications/${id}/problem-reports`).set('Authorization', asStudent()).send(body);

    it('IN_PROGRESS ⇒ 201, due_at = +48 ชม., E17 ถึงอาจารย์ และไม่เปลี่ยนสถานะใบสมัคร', async () => {
      const row = await seed('IN_PROGRESS');
      const before = Date.now();
      const res = await report(row.id, { category: 'UNSAFE_OR_HARASSMENT', detail: 'ให้ทำงานบนที่สูงโดยไม่มีอุปกรณ์' }).expect(201);
      expect(res.body).to.include({ application_id: row.id, student_user_id: student, category: 'UNSAFE_OR_HARASSMENT', status: 'OPEN', overdue: false });
      const due = new Date(res.body.due_at).getTime() - new Date(res.body.created_at).getTime();
      expect(due).to.equal(48 * 3_600_000);
      expect(new Date(res.body.created_at).getTime()).to.be.at.least(before - 1000);

      const events = await outboxOf(res.body.id);
      expect(events).to.have.length(1);
      expect(events[0].type).to.equal('ProblemReportCreated');
      expect(events[0].payload).to.deep.equal({
        problem_report_id: res.body.id,
        application_id: row.id,
        student_user_id: student,
        advisor_user_id: advisorId,
        category: 'UNSAFE_OR_HARASSMENT',
        created_at: res.body.created_at,
      });
      // ไม่มีเนื้อหารายงานใน Event และไม่แตะสถานะใบสมัคร
      expect(JSON.stringify(events[0].payload)).to.not.include('ที่สูง');
      const after = await prisma.application.findUniqueOrThrow({ where: { id: row.id } });
      expect(after.status).to.equal('IN_PROGRESS');
      expect(after.version).to.equal(row.version);
      expect(await prisma.statusHistory.count({ where: { entityId: row.id } })).to.equal(0);
      expect(await outboxOf(row.id)).to.have.length(0);
    });

    it('สถานะอื่น ⇒ 409 STATE_CONFLICT (NOT_IN_PROGRESS) • category ผิด/ไม่มี detail ⇒ 400', async () => {
      const pending = await seed('PENDING');
      const res = await report(pending.id, { category: 'OTHER', detail: 'x' }).expect(409);
      expect(res.body.error.details[0].issue).to.equal('NOT_IN_PROGRESS');

      const active = await seed('IN_PROGRESS');
      await report(active.id, { category: 'SALARY', detail: 'x' }).expect(400);
      await report(active.id, { category: 'OTHER', detail: '  ' }).expect(400);
      expect(await prisma.problemReport.count({ where: { studentUserId: student } })).to.equal(0);
    });
  });
});
