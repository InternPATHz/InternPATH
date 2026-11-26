import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import sinon from 'sinon';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { ApplicationsModule } from '../../src/modules/applications/applications.module';
import { HrApplicationsModule } from '../../src/modules/hr-applications/hr-applications.module';
import { HrApplicationsService } from '../../src/modules/hr-applications/hr-applications.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ApplicationStateMachine } from '../../src/state-machine/application-state-machine.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { ALL_CATEGORIES, TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity, FakeStorage } from '../support/profile-resume-fakes';

/** OutboxWriter มาจาก MessagingModule (Global) ในแอปจริง — เทสต์ไม่ต่อ RabbitMQ จึงให้ตัวเขียนตรง */
/** แอปจริงได้ S3StorageService จาก StorageModule (Global) — HR ใช้ออก Signed URL ของรูปโปรไฟล์ */
const hrStorage = new FakeStorage();

@Global()
@Module({
  providers: [OutboxWriter, { provide: S3StorageService, useValue: hrStorage }],
  exports: [OutboxWriter, S3StorageService],
})
class OutboxOnlyModule {}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/*
 * หัวข้อ 1.5 — ใบสมัครฝั่ง HR (api-contract §7.3) ผ่าน HTTP จริง + Postgres จริง + State Machine จริง
 * Identity/Job เป็นตัวปลอม • ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle 1.5 — ใบสมัครฝั่ง HR (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  let stateMachine: ApplicationStateMachine;
  const identity = new FakeIdentity();
  const job = new FakeJobClient();
  const http = () => request(app.getHttpServer());

  const advisorId = randomUUID();
  const hrUser = randomUUID();
  let student: string;
  let companyId: string;
  let otherCompany: string;
  let resumeId: string;
  const today = () => bangkokToday(new Date());

  const asHr = (company = companyId) =>
    bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: company, company_role: 'MEMBER', company_categories: ALL_CATEGORIES });
  const asStudent = (sub = student) => bearer({ role: 'STUDENT', sub });

  before(async function () {
    database = await createTestDatabase('lc_hr');
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
        HrApplicationsModule,
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
    stateMachine = app.get(ApplicationStateMachine, { strict: false });
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    job.reset();
    identity.students.clear();
    identity.consents.clear();
    identity.consentCalls = [];
    identity.consentBatchCalls = [];
    identity.batchExtraIds = [];
    identity.unavailable = false;
    student = randomUUID();
    companyId = randomUUID();
    otherCompany = randomUUID();
    identity.setStudent(student, {
      major: 'วิศวกรรมคอมพิวเตอร์',
      year_level: 3,
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

  /** ใส่ใบสมัครตรง (ข้าม API) เพื่อตั้งสถานะเริ่มต้น */
  const seed = async (status: ApplicationStatus, data: Record<string, unknown> = {}) => {
    const jobId = (data.jobId as string | undefined) ?? randomUUID();
    const row = await prisma.application.create({
      data: { jobId, companyId, studentUserId: student, advisorUserId: advisorId, resumeId, status, ...data },
    });
    // สายงานของประกาศ (ใช้ตรวจสิทธิ์ HR Member ตามสายงาน) — เทสต์ทั่วไปให้อยู่ในสายงาน TECH_IT
    await prisma.jobSnapshot.upsert({
      where: { jobId }, create: { jobId, companyId, title: 'x', status: 'PUBLISHED', category: 'TECH_IT' }, update: {},
    });
    // ประกาศฝั่ง Job (ตอบรับต้องอ่านช่วงฝึกงานของประกาศ) — ไม่กำหนดช่วงเป็นค่าเริ่มต้น
    if (!job.jobs.has(jobId)) job.addJob({ job_id: jobId, company_id: companyId, internship_period_start: null, internship_period_end: null });
    return row;
  };

  /** ใบที่อาจารย์อนุมัติแล้ว: จองโควตาแล้ว ช่วงฝึก 60 วันเริ่มวันนี้ */
  const seedApproved = (data: Record<string, unknown> = {}) =>
    seed('ADVISOR_APPROVED', { quotaReserved: true, startDate: today(), endDate: addDays(today(), 60), ...data });

  const action = (id: string, name: string, body: Record<string, unknown> = {}, token = asHr()) =>
    http().post(`/v1/hr/applications/${id}/actions/${name}`).set('Authorization', token).send(body);

  const reload = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });
  const lastEvent = async (id: string) =>
    (await prisma.outboxEvent.findMany({ where: { aggregateId: id }, orderBy: { createdAt: 'desc' }, take: 1 }))[0];
  const validPeriod = () => ({ start_date: ymd(addDays(today(), 7)), end_date: ymd(addDays(today(), 67)) });

  // ------------------------------------------------------------------
  describe('Guard สิทธิ์ (UAT-29)', () => {
    const endpoints = (id: string): Array<[string, string]> => [
      ['get', '/v1/hr/applications'],
      ['get', `/v1/hr/applications/${id}`],
      ...['accept', 'reject', 'rescind-offer', 'start', 'terminate', 'evaluate'].map(
        (name): [string, string] => ['post', `/v1/hr/applications/${id}/actions/${name}`],
      ),
    ];

    it('ไม่มี Token ⇒ 401 • Role อื่น ⇒ 403 FORBIDDEN_ROLE ทุก endpoint ของ §7.3', async () => {
      for (const [method, path] of endpoints(randomUUID())) {
        expect((await (http() as any)[method](path)).status, `anon ${path}`).to.equal(401);
        for (const token of [asStudent(), bearer({ role: 'ADVISOR', sub: advisorId }), bearer({ role: 'PLATFORM_ADMIN' })]) {
          const res = await (http() as any)[method](path).set('Authorization', token);
          expect(res.status, `${method} ${path}`).to.equal(403);
          expect(res.body.error.code).to.equal('FORBIDDEN_ROLE');
        }
      }
    });

    it('HR บริษัทอื่น ⇒ 403 NOT_OWNER_OF_RESOURCE ทั้งดูและกดปุ่ม และสถานะไม่เปลี่ยน; ไม่เห็นในรายการ', async () => {
      const mine = await seed('PENDING');
      const other = asHr(otherCompany);
      const bodies: Record<string, Record<string, unknown>> = {
        accept: validPeriod(),
        reject: {},
        'rescind-offer': { reason: 'x' },
        start: { actual_start_date: ymd(today()) },
        terminate: { reason: 'x' },
        evaluate: { result: 'PASS' },
      };
      for (const [method, path] of endpoints(mine.id).slice(1)) {
        const body = bodies[path.split('/').pop()!] ?? {};
        const res = await (http() as any)[method](path).set('Authorization', other).send(body);
        expect(res.status, path).to.equal(403);
        expect(res.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
      }
      expect((await reload(mine.id)).status).to.equal('PENDING');
      expect(job.calls).to.have.length(0);

      const list = await http().get('/v1/hr/applications').set('Authorization', other).expect(200);
      expect(list.body.meta.total).to.equal(0);
    });

    it('HR ไม่มี company_id ใน Token ⇒ 403 • ใบสมัครไม่มีอยู่ ⇒ 404 • id ผิดรูปแบบ ⇒ 400', async () => {
      const noCompany = bearer({ role: 'COMPANY_HR', sub: hrUser });
      expect((await http().get('/v1/hr/applications').set('Authorization', noCompany)).body.error.code).to.equal(
        'NOT_OWNER_OF_RESOURCE',
      );
      await http().get(`/v1/hr/applications/${randomUUID()}`).set('Authorization', asHr()).expect(404);
      await action(randomUUID(), 'reject').expect(404);
      await http().get('/v1/hr/applications/not-a-uuid').set('Authorization', asHr()).expect(400);
    });
  });

  // ------------------------------------------------------------------
  describe('สิทธิ์ตามสายงานของ HR Member (ปรับ 2026-11-21)', () => {
    const memberOf = (categories: string[]) =>
      bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: companyId, company_role: 'MEMBER', company_categories: categories as never });
    const owner = () => bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: companyId, company_role: 'OWNER' });
    const seedIn = async (category: 'TECH_IT' | 'BUSINESS_MARKETING' | 'CORPORATE_SERVICES', status: ApplicationStatus = 'PENDING') => {
      const jobId = randomUUID();
      await prisma.jobSnapshot.create({ data: { jobId, companyId, title: 'x', status: 'PUBLISHED', category } });
      return prisma.application.create({ data: { jobId, companyId, studentUserId: randomUUID(), advisorUserId: advisorId, resumeId, status } });
    };
    const ids = async (token: string, qs = '') =>
      (await http().get(`/v1/hr/applications${qs}`).set('Authorization', token).expect(200)).body.data.map((r: { id: string }) => r.id).sort();

    it('รายการ: Member เห็นเฉพาะใบของประกาศในสายงานตน; Owner เห็นทุกสายงาน; Member ไม่มีสายงาน ⇒ รายการว่าง; ?job_id= นอกสายงาน ⇒ ว่าง', async () => {
      const tech = await seedIn('TECH_IT');
      const biz = await seedIn('BUSINESS_MARKETING');
      const corp = await seedIn('CORPORATE_SERVICES');
      expect(await ids(memberOf(['TECH_IT']))).to.deep.equal([tech.id]);
      expect(await ids(memberOf(['TECH_IT', 'CORPORATE_SERVICES']))).to.deep.equal([tech.id, corp.id].sort());
      expect(await ids(memberOf(['BUSINESS_MARKETING']))).to.deep.equal([biz.id]);
      expect(await ids(owner())).to.deep.equal([tech.id, biz.id, corp.id].sort());
      expect(await ids(memberOf([]))).to.deep.equal([]);
      expect(await ids(memberOf(['TECH_IT']), `?job_id=${biz.jobId}`)).to.deep.equal([]);
      expect(await ids(memberOf(['BUSINESS_MARKETING']), `?job_id=${biz.jobId}`)).to.deep.equal([biz.id]);
      const total = (await http().get('/v1/hr/applications').set('Authorization', memberOf(['TECH_IT'])).expect(200)).body.meta.total;
      expect(total).to.equal(1);
    });

    it('รายละเอียด/actions ของใบนอกสายงาน ⇒ 403 FORBIDDEN_ROLE (FORBIDDEN_CATEGORY) และไม่เปลี่ยนสถานะ; ในสายงานทำได้', async () => {
      const biz = await seedIn('BUSINESS_MARKETING');
      const token = memberOf(['TECH_IT']);
      const calls: Array<['get' | 'post', string, Record<string, unknown>?]> = [
        ['get', `/v1/hr/applications/${biz.id}`],
        ['post', `/v1/hr/applications/${biz.id}/actions/reject`, { reason: 'x' }],
        ['post', `/v1/hr/applications/${biz.id}/actions/accept`, validPeriod()],
      ];
      for (const [method, url, body] of calls) {
        const req = http()[method](url).set('Authorization', token);
        const res = await (method === 'post' ? req.send(body ?? {}) : req);
        expect(res.status, url).to.equal(403);
        expect(res.body.error.code, url).to.equal('FORBIDDEN_ROLE');
        expect(res.body.error.details[0].issue, url).to.equal('FORBIDDEN_CATEGORY');
      }
      expect((await reload(biz.id)).status).to.equal('PENDING');
      await http().get(`/v1/hr/applications/${biz.id}`).set('Authorization', memberOf(['BUSINESS_MARKETING'])).expect(200);
      await http().get(`/v1/hr/applications/${biz.id}`).set('Authorization', owner()).expect(200);
      await http().post(`/v1/hr/applications/${biz.id}/actions/reject`).set('Authorization', memberOf(['BUSINESS_MARKETING'])).send({ reason: 'ไม่ตรงสาย' }).expect(200);
      expect((await reload(biz.id)).status).to.equal('HR_REJECTED');
    });

    it('Token ของ Member ที่ไม่มี company_categories ⇒ ปิดไว้ (403) ส่วนบริษัทอื่นยังเป็น NOT_OWNER_OF_RESOURCE ก่อน', async () => {
      const tech = await seedIn('TECH_IT');
      const bare = bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: companyId, company_role: 'MEMBER' });
      const res = await http().get(`/v1/hr/applications/${tech.id}`).set('Authorization', bare).expect(403);
      expect(res.body.error.details[0].issue).to.equal('FORBIDDEN_CATEGORY');
      const foreign = bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: otherCompany, company_role: 'MEMBER', company_categories: ALL_CATEGORIES });
      expect((await http().get(`/v1/hr/applications/${tech.id}`).set('Authorization', foreign).expect(403)).body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
    });

    it('snapshot ที่ยังไม่มีสายงาน ⇒ ถามจาก Job แล้วเติมให้ (ทั้งหน้ารายการและรายละเอียด); Job ไม่รู้จักประกาศ ⇒ ปิดไว้', async () => {
      const known = job.addJob({ company_id: companyId, category: 'CORPORATE_SERVICES' });
      await prisma.jobSnapshot.create({ data: { jobId: known.job_id, companyId, title: 'x', status: 'PUBLISHED' } });
      const withJob = await prisma.application.create({ data: { jobId: known.job_id, companyId, studentUserId: randomUUID(), advisorUserId: advisorId, resumeId, status: 'PENDING' } });
      const orphan = await prisma.application.create({ data: { jobId: randomUUID(), companyId, studentUserId: randomUUID(), advisorUserId: advisorId, resumeId, status: 'PENDING' } });

      expect(await ids(memberOf(['TECH_IT']))).to.deep.equal([]);
      expect(await ids(memberOf(['CORPORATE_SERVICES']))).to.deep.equal([withJob.id]);
      expect((await prisma.jobSnapshot.findUniqueOrThrow({ where: { jobId: known.job_id } })).category).to.equal('CORPORATE_SERVICES');
      await http().get(`/v1/hr/applications/${withJob.id}`).set('Authorization', memberOf(['CORPORATE_SERVICES'])).expect(200);
      await http().get(`/v1/hr/applications/${orphan.id}`).set('Authorization', memberOf(ALL_CATEGORIES)).expect(403);
      expect(await ids(owner())).to.include.members([withJob.id, orphan.id]);
    });

    it('?category=: Member กรองในสายตน; ขอสายอื่น ⇒ รายการว่าง 200; Owner กรองได้ทุกสาย; ค่าผิด ⇒ 400 (PM ตัดสิน 2026-11-21)', async () => {
      const tech = await seedIn('TECH_IT');
      const biz = await seedIn('BUSINESS_MARKETING');
      const corp = await seedIn('CORPORATE_SERVICES');
      const member = memberOf(['TECH_IT', 'CORPORATE_SERVICES']);
      expect(await ids(member, '?category=TECH_IT')).to.deep.equal([tech.id]);
      expect(await ids(member, '?category=CORPORATE_SERVICES')).to.deep.equal([corp.id]);
      const other = await http().get('/v1/hr/applications?category=BUSINESS_MARKETING').set('Authorization', member).expect(200);
      expect(other.body.data).to.deep.equal([]);
      expect(other.body.meta.total).to.equal(0);
      expect(await ids(owner(), '?category=BUSINESS_MARKETING')).to.deep.equal([biz.id]);
      expect(await ids(owner(), `?category=TECH_IT&job_id=${biz.jobId}`)).to.deep.equal([]);
      expect(await ids(owner(), `?category=TECH_IT&job_id=${tech.jobId}`)).to.deep.equal([tech.id]);
      const bad = await http().get('/v1/hr/applications?category=HR').set('Authorization', owner()).expect(400);
      expect(bad.body.error.code).to.equal('VALIDATION_FAILED');
    });

    it('Job ล่มตอนถามสายงานของประกาศที่ยังไม่รู้สาย ⇒ รายการยัง 200 โดยตัดประกาศนั้นออก (ไม่พังทั้งหน้า) + ส่ง correlation id ต่อ', async () => {
      const tech = await seedIn('TECH_IT');
      const unknown = job.addJob({ company_id: companyId, category: 'TECH_IT' });
      await prisma.jobSnapshot.create({ data: { jobId: unknown.job_id, companyId, title: 'x', status: 'PUBLISHED' } });
      const pending = await prisma.application.create({ data: { jobId: unknown.job_id, companyId, studentUserId: randomUUID(), advisorUserId: advisorId, resumeId, status: 'PENDING' } });

      job.unavailable = true;
      const res = await http().get('/v1/hr/applications').set('Authorization', memberOf(['TECH_IT'])).set('x-correlation-id', 'cid-category-list').expect(200);
      expect(res.body.data.map((r: { id: string }) => r.id)).to.deep.equal([tech.id]);
      expect(job.getJobCorrelationIds).to.include('cid-category-list');
      expect((await prisma.jobSnapshot.findUniqueOrThrow({ where: { jobId: unknown.job_id } })).category).to.equal(null);

      job.unavailable = false;
      expect(await ids(memberOf(['TECH_IT']))).to.deep.equal([tech.id, pending.id].sort());
    });

    it('รายละเอียดส่ง correlation id ต่อให้ Job ตอนเติมสายงาน', async () => {
      const unknown = job.addJob({ company_id: companyId, category: 'TECH_IT' });
      await prisma.jobSnapshot.create({ data: { jobId: unknown.job_id, companyId, title: 'x', status: 'PUBLISHED' } });
      const app = await prisma.application.create({ data: { jobId: unknown.job_id, companyId, studentUserId: randomUUID(), advisorUserId: advisorId, resumeId, status: 'PENDING' } });
      await http().get(`/v1/hr/applications/${app.id}`).set('Authorization', memberOf(['TECH_IT'])).set('x-correlation-id', 'cid-category-detail').expect(200);
      expect(job.getJobCorrelationIds).to.include('cid-category-detail');
      expect(job.getJobCorrelationIds).to.not.include(undefined);
    });
  });

  describe('GET /hr/applications และ /hr/applications/{id}', () => {
    it('รายการเฉพาะบริษัทของตน กรอง ?job_id= / ?status= + pagination; ไม่มีโปรไฟล์ในรายการ', async () => {
      const jobA = randomUUID();
      const a = await seed('PENDING', { jobId: jobA, majorMismatch: true });
      await seed('HR_ACCEPTED', { jobId: jobA, studentUserId: randomUUID() });
      await seed('PENDING', { studentUserId: randomUUID() });
      await prisma.application.create({
        data: { jobId: jobA, companyId: otherCompany, studentUserId: randomUUID(), status: 'PENDING' },
      });

      const all = await http().get('/v1/hr/applications').set('Authorization', asHr()).expect(200);
      expect(all.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 3 });
      expect(all.body.data.every((r: { company_id: string }) => r.company_id === companyId)).to.equal(true);
      expect(all.body.data[0]).to.not.have.any.keys('profile', 'cover_letter');

      const byJob = await http().get(`/v1/hr/applications?job_id=${jobA}&status=PENDING`).set('Authorization', asHr()).expect(200);
      expect(byJob.body.data.map((r: { id: string }) => r.id)).to.deep.equal([a.id]);
      expect(byJob.body.data[0]).to.include({ student_user_id: student, major_mismatch: true, company_name: 'บริษัท ทดสอบ จำกัด' });

      const paged = await http().get('/v1/hr/applications?page=2&page_size=2').set('Authorization', asHr()).expect(200);
      expect(paged.body.data).to.have.length(1);
      await http().get('/v1/hr/applications?status=NOPE').set('Authorization', asHr()).expect(400);
      await http().get('/v1/hr/applications?job_id=x').set('Authorization', asHr()).expect(400);
    });

    it('student_name ดึงสดจาก Identity เฉพาะคนที่ให้ Consent (รายการ + รายละเอียด) • ไม่มี Consent/Identity ล่ม ⇒ ไม่มีชื่อ (PM ขอ 18 พ.ย.)', async () => {
      const a = await seed('PENDING');
      const noConsent = randomUUID();
      identity.setStudent(noConsent, { full_name: 'ไม่ยินยอม ไม่แสดง' });
      const unknown = await seed('PENDING', { studentUserId: noConsent });
      const list = await http().get('/v1/hr/applications').set('Authorization', asHr()).expect(200);
      const byId = new Map(list.body.data.map((r: { id: string }) => [r.id, r]));
      expect(byId.get(a.id)).to.include({ student_name: 'สมชาย ใจดี' });
      expect(byId.get(unknown.id)).to.not.have.property('student_name');
      expect(JSON.stringify(list.body)).to.not.include('ไม่ยินยอม');
      const detail = await http().get(`/v1/hr/applications/${a.id}`).set('Authorization', asHr()).expect(200);
      expect(detail.body).to.include({ student_name: 'สมชาย ใจดี' });

      identity.unavailable = true;
      const down = await http().get('/v1/hr/applications').set('Authorization', asHr()).expect(200);
      expect(down.body.data).to.have.length(2);
      expect(down.body.data.every((r: object) => !('student_name' in r))).to.equal(true);
    });

    it('รายการตรวจ Consent ด้วย consents/check-batch ครั้งเดียวต่อหน้า (ตัด id ซ้ำ) ไม่เรียกทีละคน (PM รีวิว #82)', async () => {
      await seed('PENDING');
      await seed('HR_REJECTED');
      const other = randomUUID();
      await seed('PENDING', { studentUserId: other });
      await http().get('/v1/hr/applications').set('Authorization', asHr()).expect(200);
      expect(identity.consentCalls).to.deep.equal([]);
      expect(identity.consentBatchCalls).to.have.length(1);
      expect(identity.consentBatchCalls[0].company).to.equal(companyId);
      expect(identity.consentBatchCalls[0].students).to.have.members([student, other]);

      // ไม่มีใบสมัคร ⇒ ไม่เรียก Identity
      identity.consentBatchCalls = [];
      const empty = bearer({ role: 'COMPANY_HR', sub: randomUUID(), company_id: randomUUID(), company_role: 'MEMBER' });
      await http().get('/v1/hr/applications').set('Authorization', empty).expect(200);
      expect(identity.consentBatchCalls).to.deep.equal([]);
    });

    it('id ที่ Identity ส่งมาแต่ไม่ได้ถาม ⇒ ไม่ใช้ (ไม่ทำให้เห็นชื่อคนอื่น) • มากกว่า 100 คน ⇒ แบ่งชุดละ 100', async () => {
      await seed('PENDING');
      const stranger = randomUUID();
      identity.setStudent(stranger, { full_name: 'คนนอก ไม่ควรเห็น' });
      identity.batchExtraIds = [stranger];
      await http().get('/v1/hr/applications').set('Authorization', asHr()).expect(200);
      expect(identity.nameCalls.flat()).to.not.include(stranger);
      identity.batchExtraIds = [];

      // page_size ≤ 100 จึงเกินไม่ได้ผ่าน HTTP — เรียกเมธอดภายในตรงเพื่อตรวจการแบ่งชุด
      const service = app.get(HrApplicationsService, { strict: false }) as unknown as {
        consentedNames(company: string, ids: string[]): Promise<Map<string, string>>;
      };
      const many = Array.from({ length: 150 }, () => randomUUID());
      identity.consentBatchCalls = [];
      await service.consentedNames(companyId, [...many, many[0]]);
      expect(identity.consentBatchCalls.map((c) => c.students.length)).to.deep.equal([100, 50]);
    });

    it('มี Consent ⇒ มี profile (จากโปรไฟล์ของ Lifecycle + ชื่อสดจาก Identity) + cover_letter + available_actions; ไม่มีรายงานปัญหา', async () => {
      await prisma.studentProfile.create({
        data: { userId: student, headline: 'Backend', skills: ['TypeScript'], major: 'วิศวกรรมคอมพิวเตอร์', yearLevel: 3 },
      });
      const app1 = await seed('PENDING', { coverLetter: 'สนใจ' });
      await prisma.problemReport.create({
        data: { applicationId: app1.id, studentUserId: student, advisorUserId: advisorId, category: 'OTHER', detail: 'ลับ', dueAt: new Date() },
      });

      const res = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(res.body).to.include({ id: app1.id, cover_letter: 'สนใจ', student_user_id: student });
      expect(res.body.profile).to.deep.equal({
        headline: 'Backend',
        skills: ['TypeScript'],
        major: 'วิศวกรรมคอมพิวเตอร์',
        year_level: 3,
        full_name: 'สมชาย ใจดี',
      });
      expect(res.body.available_actions).to.have.members(['accept', 'reject']);
      expect(res.body).to.not.have.property('accept_blocked_reason');
      expect(JSON.stringify(res.body)).to.not.include('ลับ');
      expect(identity.consentCalls).to.deep.equal([{ student, company: companyId }]);
    });

    it('ไม่มี Consent / Identity ล่ม ⇒ 200 แต่ไม่มี profile (fail-closed เฉพาะข้อมูลส่วนบุคคล)', async () => {
      const app1 = await seed('PENDING');
      identity.consents.clear();
      const none = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(none.body).to.not.have.property('profile');

      identity.consents.add(`${student}:${companyId}`);
      identity.unavailable = true;
      const down = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(down.body).to.not.have.property('profile');
    });

    it('มี Consent แต่ยังไม่มีโปรไฟล์ใน Lifecycle ⇒ ใช้ major/year_level จาก Identity', async () => {
      const app1 = await seed('PENDING');
      const res = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(res.body.profile).to.deep.equal({ skills: [], major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3, full_name: 'สมชาย ใจดี' });
    });

    it('Identity อ่านนักศึกษาไม่ได้ (เช่นบัญชีถูกระงับ ⇒ 404) ⇒ มีโปรไฟล์ใน Lifecycle ส่ง full_name ว่าง • ไม่มีโปรไฟล์ ⇒ ไม่มี profile', async () => {
      const app1 = await seed('PENDING');
      identity.students.delete(student);
      const none = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(none.body).to.not.have.property('profile');

      await prisma.studentProfile.create({ data: { userId: student, skills: [], major: 'วิศวกรรมคอมพิวเตอร์', yearLevel: 3 } });
      const local = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(local.body.profile).to.deep.equal({ skills: [], major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3, full_name: '' });
    });

    it('ไม่มี Consent ⇒ ไม่เรียกดูข้อมูลนักศึกษา และไม่มีชื่อใน response', async () => {
      const app1 = await seed('PENDING');
      identity.consents.clear();
      const res = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(JSON.stringify(res.body)).to.not.include('สมชาย');
    });

    it('นักศึกษายืนยันที่อื่นอยู่ ⇒ ไม่มี accept และมี accept_blocked_reason = ALREADY_CONFIRMED_ELSEWHERE', async () => {
      await seed('ADVISOR_PENDING', { companyId: otherCompany, jobId: randomUUID() });
      const pending = await seed('PENDING');
      const res = await http().get(`/v1/hr/applications/${pending.id}`).set('Authorization', asHr()).expect(200);
      expect(res.body.available_actions).to.deep.equal(['reject']);
      expect(res.body.accept_blocked_reason).to.equal('ALREADY_CONFIRMED_ELSEWHERE');
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-06 — ลำดับ HR → นักศึกษา → อาจารย์ → HR', () => {
    it('สมัคร → accept → confirm-offer → approve → start ⇒ IN_PROGRESS; reserve ตอนตอบรับ, confirm ตอนเริ่มงาน', async () => {
      const posting = job.addJob({ company_id: companyId });
      const applied = await http()
        .post('/v1/applications')
        .set('Authorization', asStudent())
        .send({ job_id: posting.job_id, resume_id: resumeId, consent: true })
        .expect(201);
      const id = applied.body.id as string;

      const period = { start_date: ymd(today()), end_date: ymd(addDays(today(), 45)) };
      const accepted = await action(id, 'accept', period).expect(200);
      expect(accepted.body).to.include({ status: 'HR_ACCEPTED', ...period });
      expect(accepted.body.available_actions).to.have.members(['rescind-offer']);
      expect((await reload(id)).quotaReserved).to.equal(true);

      await http().post(`/v1/applications/${id}/actions/confirm-offer`).set('Authorization', asStudent()).expect(200);
      await stateMachine.execute(id, {
        trigger: 'approve',
        actor: { userId: advisorId, role: 'ADVISOR' },
        correlationId: randomUUID(),
      });

      const started = await action(id, 'start', { actual_start_date: ymd(today()) }).expect(200);
      expect(started.body).to.include({ status: 'IN_PROGRESS', actual_start_date: ymd(today()) });
      expect(started.body).to.not.have.property('warning');
      expect(job.calls.map((c) => c.op)).to.deep.equal(['reserve', 'confirm']);

      const history = await prisma.statusHistory.findMany({ where: { entityId: id }, orderBy: { occurredAt: 'asc' } });
      expect(history.map((h) => h.toStatus)).to.deep.equal([
        'PENDING',
        'HR_ACCEPTED',
        'ADVISOR_PENDING',
        'ADVISOR_APPROVED',
        'IN_PROGRESS',
      ]);
      const event = await lastEvent(id);
      expect(event.payload).to.include({ from_status: 'ADVISOR_APPROVED', to_status: 'IN_PROGRESS', actor_role: 'COMPANY_HR' });
    });
  });

  // ------------------------------------------------------------------
  describe('accept', () => {
    it('accept → Transaction ล้มหลัง reserve ⇒ release ชดเชย สถานะไม่เปลี่ยน • accept ใหม่ด้วยใบเดิมจองได้อีก (PM ตัดสิน 19 พ.ย.: RELEASED จองใหม่ได้)', async () => {
      const pending = await seed('PENDING');
      const outbox = app.get(OutboxWriter);
      // ล้มที่ Outbox E08 ซึ่งเขียนใน Transaction หลัง reserve ไปแล้ว ⇒ rollback ทั้งหมด
      const add = sinon.stub(outbox, 'add').callThrough();
      add.onFirstCall().rejects(new Error('outbox down'));
      try {
        const failed = await action(pending.id, 'accept', validPeriod());
        expect(failed.status).to.equal(500);
      } finally {
        add.restore();
      }
      expect(await reload(pending.id)).to.include({ status: 'PENDING', quotaReserved: false });
      expect(job.calls.map((c) => [c.op, c.applicationId, c.reason])).to.deep.equal([
        ['reserve', pending.id, undefined],
        ['release', pending.id, 'TRANSITION_FAILED'],
      ]);
      expect(job.reserved.has(pending.id)).to.equal(false);
      expect(await prisma.statusHistory.count({ where: { entityId: pending.id } })).to.equal(0);

      // กดตอบรับใหม่ด้วยใบสมัครเดิม ⇒ Job จองใหม่ด้วย application_id เดิม
      const retried = await action(pending.id, 'accept', validPeriod()).expect(200);
      expect(retried.body.status).to.equal('HR_ACCEPTED');
      expect(await reload(pending.id)).to.include({ status: 'HR_ACCEPTED', quotaReserved: true });
      expect(job.calls.map((c) => c.op)).to.deep.equal(['reserve', 'release', 'reserve']);
      expect(job.reserved.has(pending.id)).to.equal(true);
      expect((await prisma.statusHistory.findMany({ where: { entityId: pending.id } })).map((h) => h.toStatus)).to.deep.equal(['HR_ACCEPTED']);
      expect((await lastEvent(pending.id)).payload).to.include({ from_status: 'PENDING', to_status: 'HR_ACCEPTED' });
    });

    it('UAT-08 ข้อ 1: ช่วงฝึก < 30 วัน ⇒ 422 INVALID_PERIOD_MIN_30_DAYS และไม่จองโควตา', async () => {
      const pending = await seed('PENDING');
      const res = await action(pending.id, 'accept', {
        start_date: ymd(today()),
        end_date: ymd(addDays(today(), 29)),
      }).expect(422);
      expect(res.body.error.code).to.equal('INVALID_PERIOD_MIN_30_DAYS');
      expect(job.calls).to.have.length(0);
      expect((await reload(pending.id)).status).to.equal('PENDING');
    });

    it('วันเริ่ม/จบต้องอยู่ในช่วงฝึกงานของประกาศ: ก่อนช่วง ⇒ 400 BEFORE_JOB_PERIOD • หลังช่วง ⇒ 400 AFTER_JOB_PERIOD • ไม่จองโควตา', async () => {
      const jobId = randomUUID();
      const from = addDays(today(), 10);
      const to = addDays(today(), 100);
      job.addJob({ job_id: jobId, company_id: companyId, internship_period_start: ymd(from), internship_period_end: ymd(to) });
      const pending = await seed('PENDING', { jobId });

      const early = await action(pending.id, 'accept', { start_date: ymd(addDays(from, -1)), end_date: ymd(addDays(from, 60)) }).expect(400);
      expect(early.body.error.details).to.deep.equal([{ field: 'start_date', issue: 'BEFORE_JOB_PERIOD' }]);
      expect(early.body.error.message).to.include(ymd(from));
      const late = await action(pending.id, 'accept', { start_date: ymd(from), end_date: ymd(addDays(to, 1)) }).expect(400);
      expect(late.body.error.details).to.deep.equal([{ field: 'end_date', issue: 'AFTER_JOB_PERIOD' }]);
      expect(job.calls.filter((c) => c.op === 'reserve')).to.have.length(0);
      expect((await reload(pending.id)).status).to.equal('PENDING');

      // ตรงขอบช่วงพอดี ⇒ ผ่าน
      const ok = await action(pending.id, 'accept', { start_date: ymd(from), end_date: ymd(to) }).expect(200);
      expect(ok.body).to.include({ status: 'HR_ACCEPTED', start_date: ymd(from), end_date: ymd(to) });
    });

    it('ประกาศกำหนดแค่วันเริ่ม ⇒ ตรวจแค่วันเริ่ม • Job อ่านไม่ได้ ⇒ ไม่ปล่อยผ่าน (ไม่เปลี่ยนสถานะ)', async () => {
      const jobId = randomUUID();
      job.addJob({ job_id: jobId, company_id: companyId, internship_period_start: ymd(addDays(today(), 5)), internship_period_end: null });
      const pending = await seed('PENDING', { jobId });
      job.unavailable = true;
      await action(pending.id, 'accept', { start_date: ymd(addDays(today(), 5)), end_date: ymd(addDays(today(), 400)) }).expect(502);
      expect((await reload(pending.id)).status).to.equal('PENDING');
      job.unavailable = false;
      await action(pending.id, 'accept', { start_date: ymd(addDays(today(), 5)), end_date: ymd(addDays(today(), 400)) }).expect(200);
    });

    it('ไม่ส่ง/รูปแบบวันที่ผิด ⇒ 400 VALIDATION_FAILED', async () => {
      const pending = await seed('PENDING');
      for (const body of [{}, { start_date: ymd(today()) }, { start_date: '2026/12/01', end_date: '2027-02-01' }, { start_date: '2026-02-30', end_date: '2026-04-30' }]) {
        const res = await action(pending.id, 'accept', body).expect(400);
        expect(res.body.error.code, JSON.stringify(body)).to.equal('VALIDATION_FAILED');
      }
    });

    it('นักศึกษายืนยันที่อื่นแล้ว ⇒ 403 ALREADY_CONFIRMED_ELSEWHERE • โควตาเต็ม ⇒ 409 QUOTA_FULL • Freeze ⇒ 409 JOB_FROZEN', async () => {
      const confirmed = await seed('IN_PROGRESS', { companyId: otherCompany });
      const pending = await seed('PENDING');
      expect((await action(pending.id, 'accept', validPeriod()).expect(403)).body.error.code).to.equal(
        'ALREADY_CONFIRMED_ELSEWHERE',
      );
      await prisma.application.update({ where: { id: confirmed.id }, data: { status: 'COMPLETED' } });

      job.quotaFull = true;
      expect((await action(pending.id, 'accept', validPeriod()).expect(409)).body.error.code).to.equal('QUOTA_FULL');
      expect((await reload(pending.id)).status).to.equal('PENDING');
      job.quotaFull = false;

      const frozen = await seed('PENDING', { frozen: true, jobId: randomUUID() });
      const res = await action(frozen.id, 'accept', validPeriod()).expect(409);
      expect(res.body.error).to.deep.include({ code: 'STATE_CONFLICT', details: [{ issue: 'JOB_FROZEN' }] });
    });
  });

  // ------------------------------------------------------------------
  describe('reject / rescind-offer (UAT-33 ข้อ 3)', () => {
    it('reject: PENDING → HR_REJECTED (เหตุผลไม่บังคับ) • สถานะอื่น ⇒ 409', async () => {
      const pending = await seed('PENDING');
      const res = await action(pending.id, 'reject').expect(200);
      expect(res.body.status).to.equal('HR_REJECTED');
      expect(res.body.available_actions).to.deep.equal([]);

      const accepted = await seed('HR_ACCEPTED', { jobId: randomUUID() });
      expect((await action(accepted.id, 'reject', { reason: 'x' }).expect(409)).body.error.code).to.equal('STATE_CONFLICT');
    });

    for (const status of ['HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED'] as const) {
      it(`rescind-offer จาก ${status}: ไม่มีเหตุผล ⇒ 400 REASON_REQUIRED; มีเหตุผล ⇒ OFFER_RESCINDED + release โควตา`, async () => {
        const offered = await seed(status, { quotaReserved: true, startDate: today(), endDate: addDays(today(), 60) });
        expect((await action(offered.id, 'rescind-offer').expect(400)).body.error.code).to.equal('REASON_REQUIRED');
        expect((await action(offered.id, 'rescind-offer', { reason: '   ' }).expect(400)).body.error.code).to.equal(
          'REASON_REQUIRED',
        );

        const res = await action(offered.id, 'rescind-offer', { reason: 'ตำแหน่งถูกยกเลิก' }).expect(200);
        expect(res.body.status).to.equal('OFFER_RESCINDED');
        const row = await reload(offered.id);
        expect(row).to.include({ rescindReason: 'ตำแหน่งถูกยกเลิก', quotaReserved: false });
        expect(job.releasedFor(offered.id)).to.equal(true);
        expect((await lastEvent(offered.id)).payload).to.include({ to_status: 'OFFER_RESCINDED', reason: 'ตำแหน่งถูกยกเลิก' });
      });
    }

    it('rescind-offer ใน IN_PROGRESS ⇒ 409 (ต้องใช้ terminate)', async () => {
      const running = await seed('IN_PROGRESS');
      await action(running.id, 'rescind-offer', { reason: 'x' }).expect(409);
    });
  });

  // ------------------------------------------------------------------
  describe('start (UAT-35)', () => {
    it('ปรับ start_date/end_date ได้ + บันทึก actual_start_date + confirm โควตา', async () => {
      const approved = await seedApproved();
      const body = {
        actual_start_date: ymd(today()),
        start_date: ymd(today()),
        end_date: ymd(addDays(today(), 40)),
      };
      const res = await action(approved.id, 'start', body).expect(200);
      expect(res.body).to.include({ status: 'IN_PROGRESS', ...body });
      expect(res.body).to.not.have.property('warning');
      const row = await reload(approved.id);
      expect(ymd(row.endDate!)).to.equal(body.end_date);
      expect(job.calls).to.deep.equal([{ op: 'confirm', jobId: approved.jobId, applicationId: approved.id }]);
    });

    it('ประกาศถูก Freeze ⇒ 409 JOB_FROZEN ไม่ confirm โควตา • HR ยังถอนข้อเสนอได้ (README UAT-26)', async () => {
      const frozen = await seedApproved({ frozen: true });
      const res = await action(frozen.id, 'start', { actual_start_date: ymd(today()) }).expect(409);
      expect(res.body.error).to.deep.include({ code: 'STATE_CONFLICT', details: [{ issue: 'JOB_FROZEN' }] });
      expect((await reload(frozen.id)).status).to.equal('ADVISOR_APPROVED');
      expect(job.calls.filter((c) => c.op === 'confirm')).to.have.length(0);
      const rescind = await action(frozen.id, 'rescind-offer', { reason: 'ประกาศถูกระงับ' }).expect(200);
      expect(rescind.body.status).to.equal('OFFER_RESCINDED');
    });

    it('ระยะฝึกจริง < 30 วัน ⇒ สำเร็จแต่คืน warning NO_CERTIFICATE_ELIGIBLE', async () => {
      const approved = await seedApproved();
      const res = await action(approved.id, 'start', {
        actual_start_date: ymd(today()),
        end_date: ymd(addDays(today(), 20)),
      }).expect(200);
      expect(res.body).to.include({ status: 'IN_PROGRESS', warning: 'NO_CERTIFICATE_ELIGIBLE' });
    });

    it('ขอบ 30 วัน (รีวิว PM): end = actual_start + 29 ⇒ 200 + warning (ไม่ใช่ 400) • + 30 ⇒ 200 ไม่มี warning', async () => {
      const short = await seedApproved();
      const warned = await action(short.id, 'start', {
        actual_start_date: ymd(today()),
        end_date: ymd(addDays(today(), 29)),
      }).expect(200);
      expect(warned.body).to.include({ status: 'IN_PROGRESS', warning: 'NO_CERTIFICATE_ELIGIBLE' });
      expect(job.calls.filter((c) => c.op === 'confirm')).to.have.length(1);

      const exact = await seedApproved({ jobId: randomUUID(), studentUserId: randomUUID() });
      const ok = await action(exact.id, 'start', {
        actual_start_date: ymd(today()),
        end_date: ymd(addDays(today(), 30)),
      }).expect(200);
      expect(ok.body.status).to.equal('IN_PROGRESS');
      expect(ok.body).to.not.have.property('warning');
    });

    it('actual_start_date = วันนี้ตามเวลากรุงเทพผ่าน แม้ UTC ยังเป็นเมื่อวาน (00:30 น. ไทย) • พรุ่งนี้ ⇒ IN_FUTURE', async () => {
      const service = app.get(HrApplicationsService, { strict: false });
      const hr = { sub: hrUser, role: 'COMPANY_HR', company_id: companyId } as never;
      const now = new Date('2026-11-18T17:30:00Z'); // = 2026-11-19 00:30 Asia/Bangkok
      const body = { start_date: '2026-11-19', end_date: '2027-01-31' };

      const tomorrow = await seedApproved();
      const error = await service
        .start(hr, tomorrow.id, { actual_start_date: '2026-11-20', ...body }, undefined, now)
        .then(() => null, (e: unknown) => e as { getStatus(): number; details: unknown });
      expect(error?.getStatus()).to.equal(400);
      expect(error?.details).to.deep.equal([{ field: 'actual_start_date', issue: 'IN_FUTURE' }]);

      const res = await service.start(hr, tomorrow.id, { actual_start_date: '2026-11-19', ...body }, undefined, now);
      expect(res).to.include({ status: 'IN_PROGRESS', actual_start_date: '2026-11-19' });
    });

    it('วันเริ่มจริงก่อนวันที่อาจารย์อนุมัติ ⇒ 400 BEFORE_ADVISOR_APPROVAL (กันย้อนวันให้ครบ 30 วัน) • วันเดียวกันหรือหลังจากนั้น ⇒ ผ่าน', async () => {
      const approved = await seedApproved();
      await prisma.statusHistory.create({
        data: {
          entity: 'APPLICATION', entityId: approved.id, fromStatus: 'ADVISOR_PENDING', toStatus: 'ADVISOR_APPROVED',
          actorId: randomUUID(), actorRole: 'ADVISOR', correlationId: randomUUID(), occurredAt: addDays(new Date(), -3),
        },
      });
      const before = await action(approved.id, 'start', {
        actual_start_date: ymd(addDays(today(), -60)),
        end_date: ymd(addDays(today(), 10)),
      }).expect(400);
      expect(before.body.error.details).to.deep.equal([{ field: 'actual_start_date', issue: 'BEFORE_ADVISOR_APPROVAL' }]);
      expect((await reload(approved.id)).status).to.equal('ADVISOR_APPROVED');

      const ok = await action(approved.id, 'start', {
        actual_start_date: ymd(addDays(today(), -3)),
        end_date: ymd(addDays(today(), 40)),
      }).expect(200);
      expect(ok.body.status).to.equal('IN_PROGRESS');
    });

    it('ปรับ end_date ตอนเริ่มงานให้เกินช่วงฝึกงานของประกาศ ⇒ 400 AFTER_JOB_PERIOD ไม่ confirm โควตา', async () => {
      const jobId = randomUUID();
      job.addJob({ job_id: jobId, company_id: companyId, internship_period_start: null, internship_period_end: ymd(addDays(today(), 60)) });
      const approved = await seedApproved({ jobId });
      const res = await action(approved.id, 'start', { actual_start_date: ymd(today()), end_date: ymd(addDays(today(), 61)) }).expect(400);
      expect(res.body.error.details).to.deep.equal([{ field: 'end_date', issue: 'AFTER_JOB_PERIOD' }]);
      expect((await reload(approved.id)).status).to.equal('ADVISOR_APPROVED');
      expect(job.calls.filter((c) => c.op === 'confirm')).to.have.length(0);
    });

    it('วันที่ไม่สมเหตุผล ⇒ 400 VALIDATION_FAILED และสถานะไม่เปลี่ยน', async () => {
      const approved = await seedApproved();
      const cases: Array<[Record<string, unknown>, string, string]> = [
        [{ actual_start_date: ymd(addDays(today(), 1)) }, 'actual_start_date', 'IN_FUTURE'],
        [
          { actual_start_date: ymd(today()), start_date: ymd(addDays(today(), -5)), end_date: ymd(today()) },
          'end_date',
          'NOT_AFTER_ACTUAL_START_DATE',
        ],
        [{ actual_start_date: ymd(today()), start_date: ymd(addDays(today(), 50)), end_date: ymd(addDays(today(), 40)) }, 'end_date', 'NOT_AFTER_START_DATE'],
        [{}, 'actual_start_date', ''],
      ];
      for (const [body, field, issue] of cases) {
        const res = await action(approved.id, 'start', body).expect(400);
        expect(res.body.error.code).to.equal('VALIDATION_FAILED');
        if (issue) expect(res.body.error.details).to.deep.equal([{ field, issue }]);
      }
      expect((await reload(approved.id)).status).to.equal('ADVISOR_APPROVED');
      expect(job.calls).to.have.length(0);
    });

    it('start ก่อนอาจารย์อนุมัติ ⇒ 409 STATE_CONFLICT', async () => {
      const pending = await seed('ADVISOR_PENDING', { startDate: today(), endDate: addDays(today(), 60) });
      await action(pending.id, 'start', { actual_start_date: ymd(today()) }).expect(409);
    });
  });

  // ------------------------------------------------------------------
  describe('terminate (UAT-20)', () => {
    const seedRunning = (days = 10) =>
      seed('IN_PROGRESS', {
        quotaReserved: true,
        startDate: addDays(today(), -days),
        endDate: addDays(today(), 60),
        actualStartDate: addDays(today(), -days),
      });

    it('ไม่มีเหตุผล ⇒ 400 REASON_REQUIRED; มีเหตุผล ⇒ TERMINATED, terminated_by = COMPANY, actual_end_date = วันนี้, ไม่ release', async () => {
      const running = await seedRunning();
      expect((await action(running.id, 'terminate').expect(400)).body.error.code).to.equal('REASON_REQUIRED');

      const res = await action(running.id, 'terminate', { reason: 'ผิดข้อตกลง' }).expect(200);
      expect(res.body).to.include({ status: 'TERMINATED', actual_end_date: ymd(today()) });
      const row = await reload(running.id);
      expect(row).to.include({ terminatedBy: 'COMPANY', terminateReason: 'ผิดข้อตกลง' });
      expect(job.calls).to.have.length(0);
    });

    it('ระบุ actual_end_date ได้ • อนาคต/ก่อนวันเริ่มจริง ⇒ 400', async () => {
      const running = await seedRunning(20);
      await action(running.id, 'terminate', { reason: 'x', actual_end_date: ymd(addDays(today(), 1)) }).expect(400);
      const before = await action(running.id, 'terminate', { reason: 'x', actual_end_date: ymd(addDays(today(), -21)) }).expect(400);
      expect(before.body.error.details).to.deep.equal([{ field: 'actual_end_date', issue: 'BEFORE_ACTUAL_START_DATE' }]);

      const res = await action(running.id, 'terminate', { reason: 'x', actual_end_date: ymd(addDays(today(), -2)) }).expect(200);
      expect(res.body.actual_end_date).to.equal(ymd(addDays(today(), -2)));
    });

    it('UAT-08 ข้อ 3: ยุติที่วันที่ 10 ⇒ ประเมินไม่ได้ (422 EVALUATION_NOT_OPEN)', async () => {
      const running = await seedRunning(10);
      await action(running.id, 'terminate', { reason: 'x' }).expect(200);
      const res = await action(running.id, 'evaluate', { result: 'PASS' }).expect(422);
      expect(res.body.error).to.deep.include({ code: 'EVALUATION_NOT_OPEN', details: [{ issue: 'ACTUAL_DAYS_BELOW_MIN' }] });
    });
  });

  // ------------------------------------------------------------------
  describe('evaluate (UAT-08 ข้อ 2, UAT-21)', () => {
    it('ก่อน end_date ⇒ 422 EVALUATION_NOT_OPEN (BEFORE_END_DATE)', async () => {
      const running = await seed('IN_PROGRESS', { startDate: today(), endDate: addDays(today(), 1), actualStartDate: today() });
      const res = await action(running.id, 'evaluate', { result: 'PASS' }).expect(422);
      expect(res.body.error).to.deep.include({ code: 'EVALUATION_NOT_OPEN', details: [{ issue: 'BEFORE_END_DATE' }] });
    });

    it('FAIL ไม่มีเหตุผล ⇒ 400 REASON_REQUIRED; มีเหตุผล ⇒ EVALUATED_FAIL + evaluations round 1 + actual_end_date = end_date', async () => {
      const end = addDays(today(), -1);
      const running = await seed('IN_PROGRESS', { startDate: addDays(end, -40), endDate: end, actualStartDate: addDays(end, -40) });
      expect((await action(running.id, 'evaluate', { result: 'FAIL' }).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      await action(running.id, 'evaluate', { result: 'MAYBE' }).expect(400);

      const res = await action(running.id, 'evaluate', { result: 'FAIL', reason: 'ไม่ผ่านเกณฑ์', note: 'มาสายบ่อย' }).expect(200);
      expect(res.body).to.include({ status: 'EVALUATED_FAIL', actual_end_date: ymd(end) });
      const evaluations = await prisma.evaluation.findMany({ where: { applicationId: running.id } });
      expect(evaluations).to.have.length(1);
      expect(evaluations[0]).to.include({ round: 1, result: 'FAIL', reason: 'ไม่ผ่านเกณฑ์', scoreNote: 'มาสายบ่อย', evaluatedBy: hrUser });
      // คะแนน/หมายเหตุไม่ไปอยู่ใน E08
      expect(JSON.stringify((await lastEvent(running.id)).payload)).to.not.include('มาสายบ่อย');
    });

    it('ประเมินซ้ำจาก REEVALUATION_REQUESTED ⇒ round = 2', async () => {
      const end = addDays(today(), -10);
      const app1 = await seed('REEVALUATION_REQUESTED', {
        startDate: addDays(end, -40),
        endDate: end,
        actualStartDate: addDays(end, -40),
        actualEndDate: end,
        reevaluationUsed: true,
      });
      await prisma.evaluation.create({ data: { applicationId: app1.id, round: 1, result: 'FAIL', reason: 'x', evaluatedBy: hrUser } });

      const res = await action(app1.id, 'evaluate', { result: 'FAIL', reason: 'ยังไม่ผ่าน' }).expect(200);
      expect(res.body.status).to.equal('EVALUATED_FAIL');
      const rounds = await prisma.evaluation.findMany({ where: { applicationId: app1.id }, orderBy: { round: 'asc' } });
      expect(rounds.map((r) => r.round)).to.deep.equal([1, 2]);
    });

    it('TERMINATED ที่ฝึกจริง ≥ 30 วัน ⇒ ประเมิน PASS ได้ (round 1)', async () => {
      const app1 = await seed('TERMINATED', {
        startDate: addDays(today(), -40),
        endDate: addDays(today(), 20),
        actualStartDate: addDays(today(), -40),
        actualEndDate: addDays(today(), -5),
        terminatedBy: 'COMPANY',
      });
      const res = await action(app1.id, 'evaluate', { result: 'PASS' }).expect(200);
      expect(res.body.status).to.equal('EVALUATED_PASS');
      expect((await prisma.evaluation.findFirstOrThrow({ where: { applicationId: app1.id } })).round).to.equal(1);
    });
  });
});
