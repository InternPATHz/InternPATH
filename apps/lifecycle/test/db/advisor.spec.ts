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
import { AdvisorModule } from '../../src/modules/advisor/advisor.module';
import { ProblemReportsModule } from '../../src/modules/problem-reports/problem-reports.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { ApplicationStateMachine } from '../../src/state-machine/application-state-machine.service';
import { ApplicationTransitionService } from '../../src/state-machine/application-transition.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { ALL_CATEGORIES, TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity } from '../support/profile-resume-fakes';

/** OutboxWriter มาจาก MessagingModule (Global) ในแอปจริง — เทสต์ไม่ต่อ RabbitMQ จึงให้ตัวเขียนตรง */
@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class OutboxOnlyModule {}

const DAY_MS = 86_400_000;

/*
 * หัวข้อ 1.6 — ฝั่งอาจารย์ที่ปรึกษา (api-contract §7.4) ผ่าน HTTP จริง + Postgres จริง + State Machine จริง
 * Identity/Job เป็นตัวปลอม • ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle 1.6 — ฝั่งอาจารย์ที่ปรึกษา (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  const identity = new FakeIdentity();
  const job = new FakeJobClient();
  const http = () => request(app.getHttpServer());

  let advisor: string;
  let student: string;
  let companyId: string;
  const today = () => bangkokToday(new Date());

  const asAdvisor = (sub = advisor) => bearer({ role: 'ADVISOR', sub });
  const asAdmin = () => bearer({ role: 'PLATFORM_ADMIN', sub: randomUUID() });
  const asHr = () => bearer({ role: 'COMPANY_HR', sub: randomUUID(), company_id: companyId, company_role: 'MEMBER', company_categories: ALL_CATEGORIES });
  const asStudent = () => bearer({ role: 'STUDENT', sub: student });

  before(async function () {
    database = await createTestDatabase('lc_adv');
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
        AdvisorModule,
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

  beforeEach(() => {
    job.reset();
    advisor = randomUUID();
    student = randomUUID();
    companyId = randomUUID();
    identity.students.clear();
    identity.nameCalls = [];
    identity.summaries.clear();
    identity.summaryCalls = [];
    identity.unavailable = false;
    identity.setStudent(student, { advisor_id: advisor, advisor_link_status: 'LINKED' });
  });

  /** ใส่ใบสมัครตรง (ข้าม API) เพื่อตั้งสถานะเริ่มต้น */
  const seed = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
    prisma.application.create({
      data: { jobId: randomUUID(), companyId, studentUserId: student, advisorUserId: advisor, status, ...data },
    });

  const act = (id: string, path: string, body: Record<string, unknown> = {}, token = asAdvisor()) =>
    http().post(`/v1/advisor/applications/${id}/${path}`).set('Authorization', token).send(body);

  const reload = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });
  const historyOf = (id: string) => prisma.statusHistory.findMany({ where: { entityId: id }, orderBy: { occurredAt: 'asc' } });

  /** ใบที่บริษัทให้ FAIL แล้วนักศึกษาโต้แย้ง (ผลประเมินเมื่อ 2 วันก่อน) */
  const seedDisputed = async (data: Record<string, unknown> = {}) => {
    const disputed = await seed('FAIL_DISPUTED', {
      startDate: addDays(today(), -42),
      endDate: addDays(today(), -2),
      actualStartDate: addDays(today(), -42),
      actualEndDate: addDays(today(), -2),
      ...data,
    });
    await prisma.evaluation.create({
      data: {
        applicationId: disputed.id,
        round: 1,
        result: 'FAIL',
        reason: 'ไม่ผ่านเกณฑ์',
        evaluatedBy: randomUUID(),
        evaluatedAt: new Date(Date.now() - 2 * DAY_MS),
      },
    });
    await prisma.failDispute.create({ data: { applicationId: disputed.id, statement: 'ไม่เป็นธรรม', createdBy: student } });
    return disputed;
  };

  // ------------------------------------------------------------------
  describe('Guard สิทธิ์ (UAT-29 ข้อ 3)', () => {
    it('ไม่มี Token ⇒ 401 • Role อื่น ⇒ 403 FORBIDDEN_ROLE ทุก endpoint ของ /advisor', async () => {
      const id = randomUUID();
      const endpoints: Array<[string, string]> = [
        ['get', '/v1/advisor/applications'],
        ['get', '/v1/advisor/disputes'],
        ['get', '/v1/advisor/problem-reports'],
        ['get', `/v1/advisor/students/${id}/overview`],
        ...['actions/approve', 'actions/reject', 'actions/request-reevaluation', 'actions/uphold-fail', 'academic-result', 'actions/continue', 'actions/terminate'].map(
          (p): [string, string] => ['post', `/v1/advisor/applications/${id}/${p}`],
        ),
      ];
      for (const [method, path] of endpoints) {
        expect((await (http() as any)[method](path)).status, `anon ${path}`).to.equal(401);
        for (const token of [asStudent(), asHr(), asAdmin()]) {
          const res = await (http() as any)[method](path).set('Authorization', token);
          expect(res.status, `${method} ${path}`).to.equal(403);
          expect(res.body.error.code).to.equal('FORBIDDEN_ROLE');
        }
      }
    });

    it('อาจารย์นอกความดูแล ⇒ 403 NOT_OWNER_OF_RESOURCE ทุก action และสถานะไม่เปลี่ยน • ไม่มีใบ ⇒ 404', async () => {
      const pending = await seed('ADVISOR_PENDING');
      const other = asAdvisor(randomUUID());
      for (const [path, body] of [
        ['actions/approve', {}],
        ['actions/reject', { reason: 'x' }],
        ['actions/request-reevaluation', {}],
        ['actions/uphold-fail', {}],
        ['academic-result', { academic_result: 'ACADEMIC_PASS' }],
        ['actions/continue', {}],
        ['actions/terminate', { reason: 'x' }],
      ] as const) {
        const res = await act(pending.id, path, body, other).expect(403);
        expect(res.body.error.code, path).to.equal('NOT_OWNER_OF_RESOURCE');
      }
      expect((await reload(pending.id)).status).to.equal('ADVISOR_PENDING');

      const unlinked = await seed('ADVISOR_PENDING', { advisorUserId: null, studentUserId: randomUUID() });
      await act(unlinked.id, 'actions/approve').expect(403);
      await act(randomUUID(), 'actions/approve').expect(404);
      await act('not-a-uuid', 'actions/approve').expect(400);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /advisor/applications', () => {
    it('เฉพาะใบที่ผูกกับอาจารย์คนนี้ กรอง ?status= • ธง flagged_for_advisor ขึ้นก่อน • มี student_name/major_mismatch', async () => {
      const waiting = await seed('ADVISOR_PENDING', { majorMismatch: true });
      const flagged = await seed('IN_PROGRESS', { flaggedForAdvisor: true, studentUserId: randomUUID() });
      await prisma.application.create({
        data: { jobId: randomUUID(), companyId, studentUserId: randomUUID(), advisorUserId: randomUUID(), status: 'ADVISOR_PENDING' },
      });

      const all = await http().get('/v1/advisor/applications').set('Authorization', asAdvisor()).expect(200);
      expect(all.body.meta.total).to.equal(2);
      expect(all.body.data.map((r: { id: string }) => r.id)).to.deep.equal([flagged.id, waiting.id]);
      expect(all.body.data[0]).to.include({ flagged_for_advisor: true, student_name: '' }); // นักศึกษาที่ Identity ไม่รู้จัก ⇒ ชื่อว่าง

      const pending = await http().get('/v1/advisor/applications?status=ADVISOR_PENDING').set('Authorization', asAdvisor()).expect(200);
      expect(pending.body.data).to.have.length(1);
      expect(pending.body.data[0]).to.include({ id: waiting.id, student_user_id: student, major_mismatch: true, flagged_for_advisor: false, student_name: 'สมชาย ใจดี' });
      await http().get('/v1/advisor/applications?status=NOPE').set('Authorization', asAdvisor()).expect(400);
    });

    it('ชื่อนักศึกษาดึงจาก Identity ครั้งเดียวต่อหน้า (Batch) • Identity ล่ม ⇒ 200 ชื่อว่าง', async () => {
      const second = randomUUID();
      identity.setStudent(second, { full_name: 'สมหญิง รักเรียน' });
      await seed('ADVISOR_PENDING');
      await seed('IN_PROGRESS', { studentUserId: second });
      await seed('WITHDRAWN', { studentUserId: second, jobId: randomUUID() });

      const res = await http().get('/v1/advisor/applications').set('Authorization', asAdvisor()).expect(200);
      expect(res.body.data.map((r: { student_name: string }) => r.student_name)).to.have.members([
        'สมชาย ใจดี',
        'สมหญิง รักเรียน',
        'สมหญิง รักเรียน',
      ]);
      expect(identity.nameCalls).to.have.length(1);
      expect(identity.nameCalls[0]).to.have.members([student, second]);

      identity.unavailable = true;
      const down = await http().get('/v1/advisor/applications').set('Authorization', asAdvisor()).expect(200);
      expect(down.body.data.every((r: { student_name: string }) => r.student_name === '')).to.equal(true);
    });

    it('academic_result: ยังไม่บันทึก ⇒ ไม่มีฟิลด์ • หลังบันทึก ⇒ มีค่าทั้งใน response ของ academic-result และรายการ (PM ตัดสิน 2026-11-22)', async () => {
      const passed = await seed('EVALUATED_PASS');
      const terminated = await seed('TERMINATED', { studentUserId: randomUUID(), terminatedBy: 'COMPANY' });
      const byId = async () => {
        const res = await http().get('/v1/advisor/applications').set('Authorization', asAdvisor()).expect(200);
        return new Map(res.body.data.map((r: { id: string }) => [r.id, r] as const));
      };

      const before = await byId();
      expect(before.get(passed.id)).to.not.have.property('academic_result');
      expect(before.get(terminated.id)).to.not.have.property('academic_result');

      const done = await act(passed.id, 'academic-result', { academic_result: 'ACADEMIC_PASS' }).expect(200);
      expect(done.body).to.include({ id: passed.id, status: 'COMPLETED', academic_result: 'ACADEMIC_PASS' });
      const kept = await act(terminated.id, 'academic-result', { academic_result: 'REPEAT_REQUIRED' }).expect(200);
      expect(kept.body).to.include({ id: terminated.id, status: 'TERMINATED', academic_result: 'REPEAT_REQUIRED' });

      const after = await byId();
      expect(after.get(passed.id)).to.include({ status: 'COMPLETED', academic_result: 'ACADEMIC_PASS' });
      expect(after.get(terminated.id)).to.include({ status: 'TERMINATED', academic_result: 'REPEAT_REQUIRED' });
      const filtered = await http().get('/v1/advisor/applications?status=TERMINATED').set('Authorization', asAdvisor()).expect(200);
      expect(filtered.body.data[0]).to.include({ id: terminated.id, academic_result: 'REPEAT_REQUIRED' });
    });

    it('?academic_recorded=false ⇒ เฉพาะใบที่ยังไม่บันทึกผล • true ⇒ บันทึกแล้ว • meta.total นับตามตัวกรอง • ใช้ร่วมกับ ?status= ได้ • ค่าอื่น ⇒ 400', async () => {
      const recorded = await seed('TERMINATED', { terminatedBy: 'COMPANY' });
      const waiting = await seed('TERMINATED', { studentUserId: randomUUID(), terminatedBy: 'COMPANY' });
      const otherStatus = await seed('EVALUATED_PASS', { studentUserId: randomUUID() });
      await act(recorded.id, 'academic-result', { academic_result: 'REPEAT_REQUIRED' }).expect(200);
      const ids = async (query: string) => {
        const res = await http().get(`/v1/advisor/applications?${query}`).set('Authorization', asAdvisor()).expect(200);
        expect(res.body.meta.total).to.equal(res.body.data.length);
        return res.body.data.map((r: { id: string }) => r.id);
      };

      expect(await ids('academic_recorded=false')).to.have.members([waiting.id, otherStatus.id]);
      expect(await ids('academic_recorded=true')).to.deep.equal([recorded.id]);
      expect(await ids('status=TERMINATED&academic_recorded=false')).to.deep.equal([waiting.id]);
      expect(await ids('status=TERMINATED&academic_recorded=true')).to.deep.equal([recorded.id]);
      expect(await ids('status=TERMINATED')).to.have.members([recorded.id, waiting.id]);
      for (const bad of ['1', 'yes', 'TRUE', '']) {
        const res = await http().get(`/v1/advisor/applications?academic_recorded=${bad}`).set('Authorization', asAdvisor()).expect(400);
        expect(res.body.error.code).to.equal('VALIDATION_FAILED');
      }
    });
  });

  // ------------------------------------------------------------------
  describe('approve / reject (UAT-06)', () => {
    it('approve ⇒ ADVISOR_APPROVED และใบอื่นของนักศึกษาที่ PENDING → WITHDRAWN โดย SYSTEM', async () => {
      const confirmed = await seed('ADVISOR_PENDING', { quotaReserved: true });
      const otherPending = await seed('PENDING', { companyId: randomUUID() });

      const res = await act(confirmed.id, 'actions/approve').expect(200);
      expect(res.body).to.include({ id: confirmed.id, status: 'ADVISOR_APPROVED' });
      const cascaded = await reload(otherPending.id);
      expect(cascaded.status).to.equal('WITHDRAWN');
      expect((await historyOf(otherPending.id)).at(-1)).to.include({ toStatus: 'WITHDRAWN', actorRole: 'SYSTEM' });
      expect((await historyOf(confirmed.id)).at(-1)).to.include({ toStatus: 'ADVISOR_APPROVED', actorRole: 'ADVISOR', actorId: advisor });

      await act(confirmed.id, 'actions/approve').expect(409);
    });

    it('reject ไม่มีเหตุผล ⇒ 400 REASON_REQUIRED; มีเหตุผล ⇒ ADVISOR_REJECTED + release โควตา + E08 มีเหตุผล', async () => {
      const pending = await seed('ADVISOR_PENDING', { quotaReserved: true });
      expect((await act(pending.id, 'actions/reject').expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      expect((await act(pending.id, 'actions/reject', { reason: '  ' }).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      expect((await reload(pending.id)).status).to.equal('ADVISOR_PENDING');

      const res = await act(pending.id, 'actions/reject', { reason: 'ไม่ตรงหลักสูตร' }).expect(200);
      expect(res.body.status).to.equal('ADVISOR_REJECTED');
      expect(await reload(pending.id)).to.include({ advisorRejectReason: 'ไม่ตรงหลักสูตร', quotaReserved: false });
      expect(job.releasedFor(pending.id)).to.equal(true);
      const [event] = await prisma.outboxEvent.findMany({ where: { aggregateId: pending.id } });
      expect(event.payload).to.include({ to_status: 'ADVISOR_REJECTED', reason: 'ไม่ตรงหลักสูตร', actor_role: 'ADVISOR' });
    });
  });

  // ------------------------------------------------------------------
  describe('โต้แย้งผล FAIL และ academic-result (UAT-21)', () => {
    it('GET /advisor/disputes แสดงคำโต้แย้งและผลประเมินที่ถูกโต้แย้ง เฉพาะนักศึกษาในความดูแล', async () => {
      const disputed = await seedDisputed();
      await prisma.application.create({
        data: { jobId: randomUUID(), companyId, studentUserId: randomUUID(), advisorUserId: randomUUID(), status: 'FAIL_DISPUTED' },
      });
      const res = await http().get('/v1/advisor/disputes').set('Authorization', asAdvisor()).expect(200);
      expect(res.body.meta.total).to.equal(1);
      expect(res.body.data[0]).to.include({ id: disputed.id, status: 'FAIL_DISPUTED' });
      expect(res.body.data[0].dispute).to.include({ statement: 'ไม่เป็นธรรม' });
      expect(res.body.data[0].evaluation).to.include({ round: 1, result: 'FAIL', reason: 'ไม่ผ่านเกณฑ์' });
    });

    it('request-reevaluation ⇒ REEVALUATION_REQUESTED + reevaluation_used + บันทึกคำตัดสิน; รอบที่ 2 ⇒ 409', async () => {
      const disputed = await seedDisputed();
      const res = await act(disputed.id, 'actions/request-reevaluation', { note: 'ให้ประเมินใหม่' }).expect(200);
      expect(res.body.status).to.equal('REEVALUATION_REQUESTED');
      expect((await reload(disputed.id)).reevaluationUsed).to.equal(true);
      const dispute = await prisma.failDispute.findFirstOrThrow({ where: { applicationId: disputed.id } });
      expect(dispute).to.include({ decision: 'REEVALUATE', decidedBy: advisor, decisionNote: 'ให้ประเมินใหม่' });

      const again = await seedDisputed({ reevaluationUsed: true, studentUserId: randomUUID() });
      const second = await act(again.id, 'actions/request-reevaluation').expect(409);
      expect(second.body.error.details).to.deep.equal([{ issue: 'REEVALUATION_ALREADY_USED' }]);
    });

    it('uphold-fail ⇒ EVALUATED_FAIL; เปลี่ยนเป็น PASS ไม่ได้ (400) บันทึก ACADEMIC_FAIL ได้ทันที ⇒ COMPLETED', async () => {
      const disputed = await seedDisputed();
      const upheld = await act(disputed.id, 'actions/uphold-fail').expect(200);
      expect(upheld.body.status).to.equal('EVALUATED_FAIL');
      expect((await prisma.failDispute.findFirstOrThrow({ where: { applicationId: disputed.id } })).decision).to.equal('UPHOLD');

      const pass = await act(disputed.id, 'academic-result', { academic_result: 'ACADEMIC_PASS' }).expect(400);
      expect(pass.body.error).to.deep.include({
        code: 'VALIDATION_FAILED',
        details: [{ field: 'academic_result', issue: 'COMPANY_FAIL_CANNOT_BECOME_PASS' }],
      });

      const done = await act(disputed.id, 'academic-result', { academic_result: 'ACADEMIC_FAIL', note: 'ลงทะเบียนใหม่' }).expect(200);
      expect(done.body.status).to.equal('COMPLETED');
      expect(await reload(disputed.id)).to.include({ academicResult: 'ACADEMIC_FAIL', academicNote: 'ลงทะเบียนใหม่' });
      expect((await reload(disputed.id)).academicRecordedAt).to.be.instanceOf(Date);
    });

    it('EVALUATED_FAIL ที่ยังอยู่ในหน้าต่างโต้แย้ง 7 วัน ⇒ 409 DISPUTE_WINDOW_OPEN', async () => {
      const failed = await seed('EVALUATED_FAIL');
      await prisma.evaluation.create({
        data: { applicationId: failed.id, round: 1, result: 'FAIL', reason: 'x', evaluatedBy: randomUUID() },
      });
      const res = await act(failed.id, 'academic-result', { academic_result: 'REPEAT_REQUIRED' }).expect(409);
      expect(res.body.error.details).to.deep.equal([{ issue: 'DISPUTE_WINDOW_OPEN' }]);
    });

    it('academic_result_available_at: FAIL ในช่วงโต้แย้ง = ผลประเมิน + 7 วัน • ตัดสินคำโต้แย้งแล้ว/บันทึกแล้ว/ไม่ใช่ FAIL ⇒ ไม่มีฟิลด์', async () => {
      const evaluatedAt = new Date(Date.now() - 2 * DAY_MS);
      const failed = await seed('EVALUATED_FAIL');
      await prisma.evaluation.create({ data: { applicationId: failed.id, round: 1, result: 'FAIL', reason: 'x', evaluatedBy: randomUUID(), evaluatedAt } });
      const upheld = await seedDisputed({ studentUserId: randomUUID() });
      await act(upheld.id, 'actions/uphold-fail').expect(200);
      const passed = await seed('EVALUATED_PASS', { studentUserId: randomUUID() });

      const res = await http().get('/v1/advisor/applications?page_size=100').set('Authorization', asAdvisor()).expect(200);
      const byId = new Map((res.body.data as Array<{ id: string }>).map((row) => [row.id, row]));
      expect(byId.get(failed.id)).to.include({ academic_result_available_at: new Date(evaluatedAt.getTime() + 7 * DAY_MS).toISOString() });
      expect(byId.get(upheld.id)).to.include({ status: 'EVALUATED_FAIL' }).and.not.have.property('academic_result_available_at');
      expect(byId.get(passed.id)).to.not.have.property('academic_result_available_at');
      // ตรงกับ Guard: ก่อนเวลานั้น ⇒ 409 DISPUTE_WINDOW_OPEN
      await act(failed.id, 'academic-result', { academic_result: 'REPEAT_REQUIRED' }).expect(409);
      // ผลประเมินเกิน 7 วันแล้ว ⇒ เวลาอยู่ในอดีต และบันทึกได้
      await prisma.evaluation.updateMany({ where: { applicationId: failed.id }, data: { evaluatedAt: new Date(Date.now() - 8 * DAY_MS) } });
      const later = await http().get('/v1/advisor/applications?status=EVALUATED_FAIL&academic_recorded=false').set('Authorization', asAdvisor()).expect(200);
      const row = (later.body.data as Array<{ id: string; academic_result_available_at?: string }>).find((r) => r.id === failed.id)!;
      expect(new Date(row.academic_result_available_at!).getTime()).to.be.below(Date.now());
      const done = await act(failed.id, 'academic-result', { academic_result: 'REPEAT_REQUIRED' }).expect(200);
      expect(done.body).to.not.have.property('academic_result_available_at');
    });

    it('บริษัท PASS ⇒ อาจารย์ให้ ACADEMIC_FAIL ได้ (data-schema §8.1) • ค่าไม่ถูกต้อง ⇒ 400', async () => {
      const passed = await seed('EVALUATED_PASS');
      await act(passed.id, 'academic-result', { academic_result: 'PASS' }).expect(400);
      await act(passed.id, 'academic-result', {}).expect(400);
      const res = await act(passed.id, 'academic-result', { academic_result: 'ACADEMIC_FAIL' }).expect(200);
      expect(res.body.status).to.equal('COMPLETED');
    });

    it('TERMINATED / NO_EVALUATION ⇒ บันทึกผลโดยไม่เปลี่ยนสถานะ ไม่มี history/E08 ได้ครั้งเดียว • สถานะอื่น ⇒ 409', async () => {
      for (const status of ['TERMINATED', 'NO_EVALUATION'] as const) {
        const row = await seed(status, { studentUserId: randomUUID(), terminatedBy: status === 'TERMINATED' ? 'COMPANY' : null });
        const res = await act(row.id, 'academic-result', { academic_result: 'REPEAT_REQUIRED' }).expect(200);
        expect(res.body.status, status).to.equal(status);
        expect((await reload(row.id)).academicResult).to.equal('REPEAT_REQUIRED');
        expect(await historyOf(row.id)).to.have.length(0);
        expect(await prisma.outboxEvent.count({ where: { aggregateId: row.id } })).to.equal(0);

        const again = await act(row.id, 'academic-result', { academic_result: 'ACADEMIC_PASS' }).expect(409);
        expect(again.body.error.details).to.deep.equal([{ issue: 'ACADEMIC_RESULT_ALREADY_RECORDED' }]);
      }
      const running = await seed('IN_PROGRESS', { studentUserId: randomUUID() });
      await act(running.id, 'academic-result', { academic_result: 'ACADEMIC_PASS' }).expect(409);
    });
  });

  // ------------------------------------------------------------------
  describe('บริษัทถูกระงับขณะฝึก (UAT-27)', () => {
    const seedSuspended = (data: Record<string, unknown> = {}) =>
      seed('IN_PROGRESS', {
        companySuspendedDecision: 'PENDING',
        quotaReserved: true,
        startDate: addDays(today(), -10),
        endDate: addDays(today(), 50),
        actualStartDate: addDays(today(), -10),
        ...data,
      });

    it('continue ⇒ บันทึก CONTINUE สถานะยังเป็น IN_PROGRESS; ซ้ำ ⇒ 409', async () => {
      const running = await seedSuspended();
      const res = await act(running.id, 'actions/continue').expect(200);
      expect(res.body.status).to.equal('IN_PROGRESS');
      expect((await reload(running.id)).companySuspendedDecision).to.equal('CONTINUE');
      const again = await act(running.id, 'actions/continue').expect(409);
      expect(again.body.error.details).to.deep.equal([{ issue: 'NO_PENDING_COMPANY_DECISION' }]);
    });

    it('terminate ไม่มีเหตุผล ⇒ 400; มีเหตุผล ⇒ TERMINATED, terminated_by = ADVISOR, decision = TERMINATE, ไม่ release', async () => {
      const running = await seedSuspended();
      expect((await act(running.id, 'actions/terminate').expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      const res = await act(running.id, 'actions/terminate', { reason: 'บริษัทถูกระงับ' }).expect(200);
      expect(res.body).to.include({ status: 'TERMINATED', actual_end_date: today().toISOString().slice(0, 10) });
      expect(await reload(running.id)).to.include({
        terminatedBy: 'ADVISOR',
        terminateReason: 'บริษัทถูกระงับ',
        companySuspendedDecision: 'TERMINATE',
      });
      expect(job.calls).to.have.length(0);
    });

    it('ไม่ได้รออาจารย์ตัดสิน (บริษัทไม่ได้ถูกระงับ / ตัดสินแล้ว) ⇒ continue/terminate 409 NO_PENDING_COMPANY_DECISION', async () => {
      const normal = await seed('IN_PROGRESS');
      for (const [path, body] of [['actions/continue', {}], ['actions/terminate', { reason: 'x' }]] as const) {
        const res = await act(normal.id, path, body).expect(409);
        expect(res.body.error.details, path).to.deep.equal([{ issue: 'NO_PENDING_COMPANY_DECISION' }]);
      }
      const decided = await seedSuspended({ companySuspendedDecision: 'CONTINUE', studentUserId: randomUUID() });
      await act(decided.id, 'actions/terminate', { reason: 'x' }).expect(409);
      expect((await reload(normal.id)).status).to.equal('IN_PROGRESS');
    });
  });

  // ------------------------------------------------------------------
  describe('Admin ย้ายนักศึกษาระหว่างตรวจสิทธิ์กับตอนเขียน (ข้อค้นพบรีวิวความปลอดภัย 2026-11-25)', () => {
    it('คำสั่งของอาจารย์เดิมที่ผ่านการตรวจสิทธิ์ไปแล้ว ไม่เขียนผลทับใบที่ย้ายไปอาจารย์คนใหม่ ⇒ 403 และสถานะไม่เปลี่ยน', async () => {
      const stateMachine = app.get(ApplicationStateMachine);
      const transitions = app.get(ApplicationTransitionService);
      const movedTo = randomUUID();
      // ใบที่ถูกย้ายแล้ว (E07 เปลี่ยน advisor_user_id) — จำลองว่าอาจารย์เดิมตรวจสิทธิ์ผ่านก่อนการย้าย
      const waiting = await seed('ADVISOR_PENDING', { advisorUserId: movedTo, quotaReserved: true });
      const approve = stateMachine.execute(waiting.id, {
        trigger: 'approve',
        actor: { userId: advisor, role: 'ADVISOR' },
        expectedAdvisorUserId: advisor,
        correlationId: randomUUID(),
      });
      const error = await approve.then(() => null, (e: unknown) => e as { getStatus?: () => number });
      expect(error?.getStatus?.()).to.equal(403);
      expect(await reload(waiting.id)).to.include({ status: 'ADVISOR_PENDING', advisorUserId: movedTo });

      const ended = await seed('TERMINATED', { advisorUserId: movedTo, studentUserId: randomUUID() });
      const record = prisma.$transaction((tx) => transitions.recordAcademicResultWithoutTransition(tx, ended, 'ACADEMIC_FAIL', null, new Date(), advisor));
      const recordError = await record.then(() => null, (e: unknown) => e as { getStatus?: () => number });
      expect(recordError?.getStatus?.()).to.equal(403);
      expect((await reload(ended.id)).academicResult).to.equal(null);
    });
  });

  // ------------------------------------------------------------------
  describe('รายงานปัญหาระหว่างฝึกงาน (UAT-39)', () => {
    const seedReport = async (data: Record<string, unknown> = {}, appData: Record<string, unknown> = {}) => {
      const running = await seed('IN_PROGRESS', appData);
      return prisma.problemReport.create({
        data: {
          applicationId: running.id,
          studentUserId: running.studentUserId,
          advisorUserId: running.advisorUserId,
          category: 'UNSAFE_OR_HARASSMENT',
          detail: 'ถูกใช้งานนอกเวลา',
          dueAt: new Date(Date.now() + 48 * 3_600_000),
          ...data,
        },
      });
    };
    const report = (id: string, name: string, body: Record<string, unknown> = {}, token = asAdvisor()) =>
      http().post(`/v1/problem-reports/${id}/actions/${name}`).set('Authorization', token).send(body);

    it('GET /advisor/problem-reports เฉพาะของนักศึกษาในความดูแล + overdue คำนวณตอนอ่าน + กรอง ?status=', async () => {
      const late = await seedReport({ dueAt: new Date(Date.now() - 3_600_000) });
      await seedReport({}, { studentUserId: randomUUID() });
      await seedReport({}, { studentUserId: randomUUID(), advisorUserId: randomUUID() });

      const res = await http().get('/v1/advisor/problem-reports').set('Authorization', asAdvisor()).expect(200);
      expect(res.body.meta.total).to.equal(2);
      expect(res.body.data[0]).to.include({ id: late.id, overdue: true, status: 'OPEN', detail: 'ถูกใช้งานนอกเวลา' });
      expect(res.body.data[1].overdue).to.equal(false);

      const resolved = await http().get('/v1/advisor/problem-reports?status=RESOLVED').set('Authorization', asAdvisor()).expect(200);
      expect(resolved.body.meta.total).to.equal(0);
    });

    it('acknowledge OPEN → ACKNOWLEDGED (ซ้ำ ⇒ 409) → resolve ต้องมี note → RESOLVED (ซ้ำ ⇒ 409) • สถานะใบสมัครไม่เปลี่ยน', async () => {
      const r = await seedReport();
      const ack = await report(r.id, 'acknowledge').expect(200);
      expect(ack.body.status).to.equal('ACKNOWLEDGED');
      expect((await report(r.id, 'acknowledge').expect(409)).body.error.details).to.deep.equal([{ issue: 'NOT_OPEN' }]);

      expect((await report(r.id, 'resolve').expect(400)).body.error.code).to.equal('VALIDATION_FAILED');
      await report(r.id, 'resolve', { note: 'x', follow_up_action: 'NOPE' }).expect(400);
      const done = await report(r.id, 'resolve', { note: 'คุยกับบริษัทแล้ว', follow_up_action: 'MONITOR_COMPANY' }).expect(200);
      expect(done.body).to.include({ status: 'RESOLVED', resolution_note: 'คุยกับบริษัทแล้ว', follow_up_action: 'MONITOR_COMPANY', overdue: false });
      const row = await prisma.problemReport.findUniqueOrThrow({ where: { id: r.id } });
      expect(row).to.include({ acknowledgedBy: advisor, resolvedBy: advisor });
      expect((await report(r.id, 'resolve', { note: 'อีกครั้ง' }).expect(409)).body.error.details).to.deep.equal([
        { issue: 'ALREADY_RESOLVED' },
      ]);
      expect((await reload(r.applicationId)).status).to.equal('IN_PROGRESS');
    });

    it('resolve จาก OPEN ได้ตรง (ตั้ง acknowledged ไปด้วย) • follow_up_action TERMINATE ไม่ยุติใบสมัครเอง', async () => {
      const r = await seedReport();
      await report(r.id, 'resolve', { note: 'ให้ยุติ', follow_up_action: 'TERMINATE' }).expect(200);
      const row = await prisma.problemReport.findUniqueOrThrow({ where: { id: r.id } });
      expect(row.acknowledgedAt).to.be.instanceOf(Date);
      expect((await reload(r.applicationId)).status).to.equal('IN_PROGRESS');
    });

    it('Admin จัดการได้ทุกรายงาน • อาจารย์อื่น ⇒ 403 • HR/นักศึกษา ⇒ 403 FORBIDDEN_ROLE • ไม่มี ⇒ 404', async () => {
      const r = await seedReport();
      expect((await report(r.id, 'acknowledge', {}, asAdvisor(randomUUID())).expect(403)).body.error.code).to.equal(
        'NOT_OWNER_OF_RESOURCE',
      );
      for (const token of [asHr(), asStudent()]) {
        for (const name of ['acknowledge', 'resolve']) {
          const res = await report(r.id, name, { note: 'x' }, token).expect(403);
          expect(res.body.error.code).to.equal('FORBIDDEN_ROLE');
        }
      }
      expect((await report(r.id, 'acknowledge', {}, asAdmin()).expect(200)).body.status).to.equal('ACKNOWLEDGED');
      await report(randomUUID(), 'acknowledge').expect(404);
      expect((await prisma.problemReport.findUniqueOrThrow({ where: { id: r.id } })).status).to.equal('ACKNOWLEDGED');
    });

    it('อาจารย์ที่ถูกย้ายมา (advisor_user_id ของใบสมัครเปลี่ยนตาม E07) จัดการรายงานได้ อาจารย์เดิมไม่ได้', async () => {
      const r = await seedReport();
      const newAdvisor = randomUUID();
      await prisma.application.update({ where: { id: r.applicationId }, data: { advisorUserId: newAdvisor } });
      await report(r.id, 'acknowledge', {}, asAdvisor()).expect(403);
      await report(r.id, 'acknowledge', {}, asAdvisor(newAdvisor)).expect(200);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /advisor/students/{id}/overview', () => {
    it('นักศึกษาในความดูแล ⇒ ใบสมัครที่ผูกกับอาจารย์คนนี้เท่านั้น • นอกความดูแล ⇒ 403', async () => {
      const mine = await seed('IN_PROGRESS');
      await seed('WITHDRAWN', { advisorUserId: randomUUID() });

      const res = await http().get(`/v1/advisor/students/${student}/overview`).set('Authorization', asAdvisor()).expect(200);
      expect(res.body).to.include({ student_user_id: student, full_name: 'สมชาย ใจดี' });
      expect(res.body.applications.map((a: { id: string }) => a.id)).to.deep.equal([mine.id]);

      const other = await http().get(`/v1/advisor/students/${student}/overview`).set('Authorization', asAdvisor(randomUUID())).expect(403);
      expect(other.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
    });

    describe('GET /advisor/students — ตัวกรองชั้นปี / กำลังฝึกงาน / ฝึกงานเสร็จแล้ว (ปรับ 2026-11-21)', () => {
      const addStudent = async (code: string, over: { year?: number; name?: string; linked?: boolean; advisorId?: string } = {}) => {
        const id = randomUUID();
        identity.setStudent(id, { full_name: over.name ?? `นักศึกษา ${code}`, year_level: over.year ?? 3, major: 'วิทยาการคอมพิวเตอร์' });
        identity.summaries.set(id, { student_code: code });
        await prisma.studentAdvisorLink.create({
          data: { studentUserId: id, advisorUserId: over.advisorId ?? advisor, linkStatus: over.linked === false ? 'NONE' : 'LINKED' },
        });
        return id;
      };
      const apply = (studentUserId: string, status: ApplicationStatus) =>
        prisma.application.create({ data: { jobId: randomUUID(), companyId, studentUserId, advisorUserId: advisor, status } });
      const list = (qs = '', token = asAdvisor()) => http().get(`/v1/advisor/students${qs}`).set('Authorization', token);

      it('คืนเฉพาะนักศึกษาที่ LINKED กับอาจารย์ พร้อมสถานะฝึกงาน/จำนวนใบที่ดำเนินอยู่ และไม่เก็บชื่อลงฐานข้อมูล', async () => {
        const training = await addStudent('B001', { year: 3 });
        const done = await addStudent('B002', { year: 4 });
        const none = await addStudent('B003', { year: 3 });
        const both = await addStudent('B004', { year: 4 });
        await addStudent('B999', { advisorId: randomUUID() }); // ของอาจารย์คนอื่น
        await addStudent('B998', { linked: false }); // ยังไม่ผูก
        await apply(training, 'IN_PROGRESS');
        await apply(training, 'PENDING');
        await apply(training, 'WITHDRAWN'); // ไม่นับเป็นใบที่ดำเนินอยู่
        await apply(done, 'COMPLETED');
        await apply(both, 'COMPLETED');
        await apply(both, 'IN_PROGRESS');
        await apply(none, 'CANCELLED');

        const res = await list().expect(200);
        expect(res.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 4 });
        expect(res.body.data.map((s: { student_code: string }) => s.student_code)).to.deep.equal(['B001', 'B002', 'B003', 'B004']);
        const byCode = Object.fromEntries(res.body.data.map((s: { student_code: string }) => [s.student_code, s]));
        expect(byCode.B001).to.deep.include({ student_user_id: training, full_name: 'นักศึกษา B001', year_level: 3, training_status: 'IN_TRAINING', active_application_count: 2 });
        expect(byCode.B002).to.deep.include({ training_status: 'COMPLETED', active_application_count: 0 });
        expect(byCode.B003).to.deep.include({ training_status: 'NONE', active_application_count: 0 });
        expect(byCode.B004).to.deep.include({ training_status: 'IN_TRAINING', active_application_count: 1 }); // กำลังฝึกมาก่อน COMPLETED
        expect(res.body.data[0]).to.have.all.keys('student_user_id', 'full_name', 'student_code', 'major', 'year_level', 'training_status', 'active_application_count');
        // ฝึกจบแล้วแต่ยังไม่ COMPLETED (บริษัทประเมินแล้ว/โต้แย้ง/ถูกยุติ) ต้องไม่ขึ้นว่ายังไม่ได้ฝึก
        for (const status of ['EVALUATED_PASS', 'EVALUATED_FAIL', 'FAIL_DISPUTED', 'TERMINATED'] as ApplicationStatus[]) {
          const id = await addStudent(`E-${status}`);
          await apply(id, status);
          const row = (await list(`?q=E-${status}`).expect(200)).body.data[0];
          expect(row, status).to.deep.include({ training_status: 'COMPLETED' });
        }
        // ดึงสดจาก Identity: ชื่อไม่อยู่ในตารางใดของ Lifecycle
        expect(JSON.stringify(await prisma.application.findMany())).to.not.include('นักศึกษา B00');
        expect(JSON.stringify(await prisma.studentAdvisorLink.findMany())).to.not.include('นักศึกษา B00');
      });

      it('ตัวกรอง year_level, training_status=IN_TRAINING|COMPLETED, q และรวมกันได้ + Pagination', async () => {
        const a = await addStudent('C001', { year: 3, name: 'สมศรี ใจดี' });
        const b = await addStudent('C002', { year: 4, name: 'สมศักดิ์ มั่นคง' });
        const c = await addStudent('C003', { year: 4, name: 'วีระ ขยัน' });
        await apply(a, 'IN_PROGRESS');
        await apply(b, 'IN_PROGRESS');
        await apply(c, 'COMPLETED');
        const codes = async (qs: string) => (await list(qs).expect(200)).body.data.map((s: { student_code: string }) => s.student_code);

        expect(await codes('?year_level=4')).to.deep.equal(['C002', 'C003']);
        expect(await codes('?training_status=IN_TRAINING')).to.deep.equal(['C001', 'C002']);
        expect(await codes('?training_status=COMPLETED')).to.deep.equal(['C003']);
        expect(await codes('?training_status=IN_TRAINING&year_level=4')).to.deep.equal(['C002']);
        expect(await codes('?q=สมศักดิ์')).to.deep.equal(['C002']);
        expect(await codes('?q=c003')).to.deep.equal(['C003']);
        expect(await codes('?year_level=9')).to.deep.equal([]);
        const second = await list('?page=2&page_size=2').expect(200);
        expect(second.body.meta).to.deep.equal({ page: 2, page_size: 2, total: 3 });
        expect(second.body.data.map((s: { student_code: string }) => s.student_code)).to.deep.equal(['C003']);
      });

      it('ตัวกรองไม่ถูกต้อง ⇒ 400; Identity ล่ม ⇒ 502; บัญชีที่ Identity ไม่คืน (ลบแล้ว) ถูกข้าม; role อื่น 403; ไม่ล็อกอิน 401', async () => {
        const kept = await addStudent('D001');
        const gone = await addStudent('D002');
        identity.summaries.delete(gone);
        expect((await list().expect(200)).body.data.map((s: { student_user_id: string }) => s.student_user_id)).to.deep.equal([kept]);
        for (const bad of ['?training_status=NONE', '?training_status=x', '?year_level=0', '?year_level=11', '?page_size=101']) await list(bad).expect(400);
        identity.unavailable = true;
        await list().expect(502);
        identity.unavailable = false;
        await list('', asHr()).expect(403);
        await list('', asStudent()).expect(403);
        await http().get('/v1/advisor/students').expect(401);
      });

      it('Batch ไปที่ Identity ไม่เกิน 100 id ต่อครั้ง', async () => {
        identity.summaryCalls = [];
        for (let i = 0; i < 101; i++) await addStudent(`E${String(i).padStart(3, '0')}`);
        const res = await list('?page_size=100').expect(200);
        expect(res.body.meta.total).to.equal(101);
        expect(identity.summaryCalls.map((ids) => ids.length)).to.deep.equal([100, 1]);
      });
    });

    it('ผูกกันแล้วแต่ยังไม่มีใบสมัคร ⇒ 200 รายการว่าง • ยกเลิกผูกแล้ว (NONE) ⇒ 403', async () => {
      await prisma.studentAdvisorLink.create({ data: { studentUserId: student, advisorUserId: advisor, linkStatus: 'LINKED' } });
      const res = await http().get(`/v1/advisor/students/${student}/overview`).set('Authorization', asAdvisor()).expect(200);
      expect(res.body.applications).to.deep.equal([]);

      // E07 UNLINKED ล้างอาจารย์ของลิงก์เป็น NONE (ADVISOR_LINK_PENDING เลิกใช้ — PM ตัดสิน 2026-11-22)
      const unlinked = randomUUID();
      await prisma.studentAdvisorLink.create({ data: { studentUserId: unlinked, advisorUserId: null, linkStatus: 'NONE' } });
      await http().get(`/v1/advisor/students/${unlinked}/overview`).set('Authorization', asAdvisor()).expect(403);
    });
  });
});
