import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { InvalidMessageError, OutboxWriter, configureApp, signServiceToken } from '@internpath/common';
import type { EventEnvelope, ServiceName } from '@internpath/contracts';
import { expect } from 'chai';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { LifecycleEventHandlersModule } from '../../src/events/consumers/lifecycle-consumers.module';
import { AdvisorLinkChangedHandler } from '../../src/events/handlers/advisor-link-changed.handler';
import { CompanyStatusChangedHandler } from '../../src/events/handlers/company-status-changed.handler';
import { JobStatusChangedHandler } from '../../src/events/handlers/job-status-changed.handler';
import { DELETED_HOLDER_NAME, UserDeletionHandler } from '../../src/events/handlers/user-deletion.handler';
import { DeletionEligibilityModule } from '../../src/internal/deletion-eligibility.controller';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { Tx } from '../../src/prisma/types';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT } from '../support/jwt';
import { FakeStorage } from '../support/profile-resume-fakes';

const storage = new FakeStorage();

/** แอปจริงได้ OutboxWriter จาก MessagingModule และ S3StorageService จาก StorageModule (Global ทั้งคู่) */
@Global()
@Module({
  providers: [OutboxWriter, { provide: S3StorageService, useValue: storage }],
  exports: [OutboxWriter, S3StorageService],
})
class TestGlobalsModule {}

const IDENTITY_SECRET = 'identity-to-lifecycle-test-secret-0123456789';
const HOUR_MS = 3_600_000;

/** ซองข้อความแบบที่ libs/common ส่งให้ handler */
function envelope<P>(type: string, producer: ServiceName, payload: P): EventEnvelope<string, P> {
  return {
    event_id: randomUUID(),
    type,
    version: 1,
    occurred_at: new Date().toISOString(),
    correlation_id: randomUUID(),
    producer,
    payload,
  };
}

/*
 * หัวข้อ 1.11 — Consumer E03/E05/E07/E15 + deletion-eligibility (Postgres จริง + State Machine จริง)
 * เรียก handler ใน Transaction เหมือนที่ `EventConsumer` ของ libs/common ทำ (กันซ้ำด้วย event_id เทสต์ใน libs/common แล้ว
 * — ที่นี่เทสต์ "ส่งซ้ำด้วย event ใหม่ที่ entity_version เดิม" ซึ่ง processed_events ไม่ช่วย)
 */
describe('Lifecycle 1.11 — Consumer และการลบข้อมูล (Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  let jobs: JobStatusChangedHandler;
  let companies: CompanyStatusChangedHandler;
  let links: AdvisorLinkChangedHandler;
  let deletions: UserDeletionHandler;
  const job = new FakeJobClient();

  let companyId: string;
  let jobId: string;
  let advisor: string;
  const today = () => bangkokToday(new Date());

  before(async function () {
    database = await createTestDatabase('lc_cons');
    if (!database) this.skip();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [
            () => ({
              JWT_PUBLIC_KEY: TEST_JWT.publicKey,
              LIFECYCLE_DATABASE_URL: database!.url,
              LIFECYCLE_SERVICE_SECRET_IDENTITY: IDENTITY_SECRET,
            }),
          ],
        }),
        PrismaModule,
        LifecycleConfigModule,
        InternalModule,
        TestGlobalsModule,
        LifecycleEventHandlersModule,
        DeletionEligibilityModule,
      ],
    })
      .overrideProvider(JobInternalClient)
      .useValue(job)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    jobs = app.get(JobStatusChangedHandler);
    companies = app.get(CompanyStatusChangedHandler);
    links = app.get(AdvisorLinkChangedHandler);
    deletions = app.get(UserDeletionHandler);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(() => {
    job.reset();
    storage.objects.clear();
    storage.deleted = [];
    storage.failDelete = false;
    companyId = randomUUID();
    jobId = randomUUID();
    advisor = randomUUID();
  });

  const inTx = <T>(fn: (tx: Tx) => Promise<T>) => prisma.$transaction(fn);
  const seed = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
    prisma.application.create({
      data: { jobId, companyId, studentUserId: randomUUID(), advisorUserId: advisor, status, ...data },
    });
  const reload = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });

  // ------------------------------------------------------------------
  describe('E03 JobStatusChanged', () => {
    const e03 = (version: number, to: string, effect?: string, changedAt = new Date(), from = 'PUBLISHED') =>
      envelope('JobStatusChanged', 'job', {
        job_id: jobId,
        company_id: companyId,
        from_status: from,
        to_status: to,
        entity_version: version,
        changed_at: changedAt.toISOString(),
        ...(effect ? { application_effect: effect } : {}),
      });
    const handle = (env: ReturnType<typeof e03>) => inTx((tx) => jobs.handle(env as never, tx));

    it('สร้าง/อัปเดต job_snapshots ตาม entity_version (คงชื่อเดิม) • Event เก่า/เท่ากัน ⇒ ข้ามทั้ง snapshot และ effect', async () => {
      expect(await handle(e03(3, 'PUBLISHED', 'NONE'))).to.equal('applied');
      expect(await prisma.jobSnapshot.findUniqueOrThrow({ where: { jobId } })).to.include({ status: 'PUBLISHED', entityVersion: 3, title: '' });

      await prisma.jobSnapshot.update({ where: { jobId }, data: { title: 'Backend Intern' } });
      const pending = await seed('PENDING');
      expect(await handle(e03(3, 'VERIFYING', 'FREEZE'))).to.equal('stale');
      expect(await handle(e03(2, 'VERIFYING', 'FREEZE'))).to.equal('stale');
      expect((await reload(pending.id)).frozen).to.equal(false);

      expect(await handle(e03(4, 'CLOSED', 'NONE'))).to.equal('applied');
      expect(await prisma.jobSnapshot.findUniqueOrThrow({ where: { jobId } })).to.include({
        status: 'CLOSED',
        entityVersion: 4,
        title: 'Backend Intern',
      });
    });

    it('FREEZE ใบที่ค้างก่อนฝึก (ไม่แตะ IN_PROGRESS/สิ้นสุด) • UNFREEZE สะสมเวลาลง sla_paused_seconds', async () => {
      const frozenAt = new Date(Date.now() - 5 * HOUR_MS);
      const targets = await Promise.all(
        (['PENDING', 'HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED'] as const).map((s) => seed(s, { slaPausedSeconds: 60 })),
      );
      const running = await seed('IN_PROGRESS');
      const ended = await seed('WITHDRAWN');

      await handle(e03(2, 'VERIFYING', 'FREEZE', frozenAt));
      for (const t of targets) {
        const row = await reload(t.id);
        expect(row.frozen, t.status).to.equal(true);
        expect(row.frozenAt?.toISOString()).to.equal(frozenAt.toISOString());
      }
      expect((await reload(running.id)).frozen).to.equal(false);
      expect((await reload(ended.id)).frozen).to.equal(false);

      await handle(e03(3, 'PUBLISHED', 'UNFREEZE', new Date(frozenAt.getTime() + 2 * HOUR_MS), 'VERIFYING'));
      for (const t of targets) {
        expect(await reload(t.id)).to.include({ frozen: false, frozenAt: null, slaPausedSeconds: 60 + 7200 });
      }
    });

    it('UNFREEZE ไม่ปลดใบของบริษัทที่ยังถูกระงับ', async () => {
      await prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท', status: 'SUSPENDED' } });
      const pending = await seed('PENDING', { frozen: true, frozenAt: new Date(Date.now() - HOUR_MS) });
      await handle(e03(2, 'PUBLISHED', 'UNFREEZE', new Date(), 'SUSPENDED'));
      expect((await reload(pending.id)).frozen).to.equal(true);
    });

    it('CANCEL_PRE_APPROVAL: ก่อน ADVISOR_APPROVED ⇒ CANCELLED + E08 + คืนโควตา • ADVISOR_APPROVED/IN_PROGRESS ⇒ ติดธง (UAT-26)', async () => {
      const pending = await seed('PENDING');
      const accepted = await seed('HR_ACCEPTED', { quotaReserved: true });
      const advisorPending = await seed('ADVISOR_PENDING', { quotaReserved: true });
      const approved = await seed('ADVISOR_APPROVED', { quotaReserved: true });
      const running = await seed('IN_PROGRESS', { quotaReserved: true });
      const ended = await seed('EXPIRED');

      await handle(e03(2, 'ADMIN_REJECTED', 'CANCEL_PRE_APPROVAL', new Date(), 'VERIFYING'));

      for (const t of [pending, accepted, advisorPending]) {
        const row = await reload(t.id);
        expect(row.status, t.status).to.equal('CANCELLED');
        const [history] = await prisma.statusHistory.findMany({ where: { entityId: t.id } });
        expect(history).to.include({ fromStatus: t.status, toStatus: 'CANCELLED', actorRole: 'SYSTEM', actorId: null, reason: 'JOB_ADMIN_REJECTED' });
        expect((await prisma.outboxEvent.findMany({ where: { aggregateId: t.id } })).map((e) => e.type)).to.deep.equal([
          'ApplicationStatusChanged',
        ]);
      }
      expect(job.calls.filter((c) => c.op === 'release').map((c) => c.applicationId).sort()).to.deep.equal(
        [accepted.id, advisorPending.id].sort(),
      );
      for (const t of [approved, running]) {
        expect(await reload(t.id)).to.include({ status: t.status, flaggedForAdvisor: true });
      }
      expect(await reload(ended.id)).to.include({ status: 'EXPIRED', flaggedForAdvisor: false });
    });

    // PM ขอ (18 พ.ย. — event-contract E04 ข้อ 5): E03 สองรายการติดกัน FREEZE (v2) แล้ว REMOVE (v3)
    describe('E03 คู่ SUSPENDED → REMOVED (ปกติ / สลับลำดับ / ซ้ำ) — ทั้งใบก่อนและหลังอาจารย์อนุมัติ', () => {
      const suspend = () => e03(2, 'SUSPENDED', 'FREEZE', new Date(Date.now() - HOUR_MS));
      const remove = () => e03(3, 'REMOVED', 'CANCEL_PRE_APPROVAL', new Date(), 'SUSPENDED');

      it('ปกติ: ก่อนอนุมัติ ⇒ CANCELLED + คืนโควตา • หลังอนุมัติ ⇒ ติดธง ไม่เปลี่ยนสถานะ', async () => {
        const before = await seed('HR_ACCEPTED', { quotaReserved: true });
        const after = await seed('ADVISOR_APPROVED', { quotaReserved: true });
        expect(await handle(suspend())).to.equal('applied');
        expect((await reload(before.id)).frozen).to.equal(true);
        expect(await handle(remove())).to.equal('applied');

        expect((await reload(before.id)).status).to.equal('CANCELLED');
        expect(await reload(after.id)).to.include({ status: 'ADVISOR_APPROVED', flaggedForAdvisor: true });
        expect(job.calls.filter((c) => c.op === 'release').map((c) => c.applicationId)).to.deep.equal([before.id]);
        expect(await prisma.jobSnapshot.findUniqueOrThrow({ where: { jobId } })).to.include({ status: 'REMOVED', entityVersion: 3 });
      });

      it('สลับลำดับ (REMOVE มาก่อน): ผลเท่าเส้นทางปกติ และ FREEZE ที่มาทีหลังถูกข้าม (ไม่ Freeze ใบที่ติดธงย้อนหลัง)', async () => {
        const before = await seed('PENDING');
        const after = await seed('ADVISOR_APPROVED', { quotaReserved: true });
        expect(await handle(remove())).to.equal('applied');
        expect(await handle(suspend())).to.equal('stale');

        expect((await reload(before.id)).status).to.equal('CANCELLED');
        expect(await reload(after.id)).to.include({ status: 'ADVISOR_APPROVED', flaggedForAdvisor: true, frozen: false });
        expect(await prisma.jobSnapshot.findUniqueOrThrow({ where: { jobId } })).to.include({ status: 'REMOVED', entityVersion: 3 });
      });

      it('ส่งซ้ำ (event_id ใหม่ entity_version เดิม): ไม่ยกเลิก/บันทึกประวัติซ้ำ และไม่ error', async () => {
        const before = await seed('HR_ACCEPTED', { quotaReserved: true });
        await handle(suspend());
        await handle(remove());
        expect(await handle(remove())).to.equal('stale');
        expect(await handle(suspend())).to.equal('stale');
        expect(await prisma.statusHistory.count({ where: { entityId: before.id } })).to.equal(1);
        expect(job.calls.filter((c) => c.op === 'release')).to.have.length(1);
      });
    });

    it('payload ผิดรูป ⇒ InvalidMessageError (dead-letter ทันที)', async () => {
      const bad = [
        { ...e03(2, 'PUBLISHED').payload, job_id: 'x' },
        { ...e03(2, 'NOT_A_STATUS').payload },
        { ...e03(0, 'PUBLISHED').payload },
        { ...e03(2, 'PUBLISHED').payload, changed_at: 'yesterday' },
        { ...e03(2, 'PUBLISHED').payload, application_effect: 'EXPLODE' },
      ];
      for (const payload of bad) {
        let error: unknown;
        await inTx((tx) => jobs.handle(envelope('JobStatusChanged', 'job', payload) as never, tx)).catch((e: unknown) => (error = e));
        expect(error).to.be.instanceOf(InvalidMessageError);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('E05 CompanyStatusChanged', () => {
    const e05 = (version: number, status: string, changedAt = new Date(), name = 'บริษัท ทดสอบ จำกัด') =>
      envelope('CompanyStatusChanged', 'identity', {
        company_id: companyId,
        status,
        snapshot: { name, university_partner: true, verified_badge: true, logo_key: 'logos/a.png' },
        entity_version: version,
        changed_at: changedAt.toISOString(),
      });
    const handle = (env: ReturnType<typeof e05>) => inTx((tx) => companies.handle(env as never, tx));

    it('สร้าง/อัปเดต company_snapshots ตาม entity_version (Event เก่าไม่ทับใหม่)', async () => {
      await handle(e05(2, 'VERIFIED'));
      expect(await prisma.companySnapshot.findUniqueOrThrow({ where: { companyId } })).to.include({
        name: 'บริษัท ทดสอบ จำกัด',
        status: 'VERIFIED',
        universityPartner: true,
        logoKey: 'logos/a.png',
        entityVersion: 2,
      });
      expect(await handle(e05(1, 'PENDING', new Date(), 'ชื่อเก่า'))).to.equal('stale');
      expect(await prisma.companySnapshot.findUniqueOrThrow({ where: { companyId } })).to.include({ status: 'VERIFIED', name: 'บริษัท ทดสอบ จำกัด' });
    });

    it('SUSPENDED ⇒ Freeze ใบก่อนฝึก + IN_PROGRESS รออาจารย์ตัดสิน (UAT-27) ไม่คืนโควตา • VERIFIED ⇒ ปลด + ล้างการรอตัดสิน', async () => {
      await handle(e05(1, 'VERIFIED'));
      const suspendedAt = new Date(Date.now() - 3 * HOUR_MS);
      const accepted = await seed('HR_ACCEPTED', { quotaReserved: true });
      const running = await seed('IN_PROGRESS', { quotaReserved: true });
      const decided = await seed('IN_PROGRESS', { companySuspendedDecision: 'TERMINATE' });

      await handle(e05(2, 'SUSPENDED', suspendedAt));
      expect(await reload(accepted.id)).to.include({ frozen: true, status: 'HR_ACCEPTED', quotaReserved: true });
      expect(await reload(running.id)).to.include({ frozen: false, companySuspendedDecision: 'PENDING' });
      expect((await reload(decided.id)).companySuspendedDecision).to.equal('TERMINATE');
      expect(job.calls).to.deep.equal([]);

      await handle(e05(3, 'VERIFIED', new Date(suspendedAt.getTime() + HOUR_MS)));
      expect(await reload(accepted.id)).to.include({ frozen: false, slaPausedSeconds: 3600 });
      expect((await reload(running.id)).companySuspendedDecision).to.equal(null);
    });

    it('VERIFIED ไม่ปลดใบที่ประกาศยังถูกซ่อน (VERIFYING/PENDING_REVIEW/SUSPENDED)', async () => {
      await prisma.jobSnapshot.create({ data: { jobId, companyId, status: 'PENDING_REVIEW', title: 'x' } });
      const pending = await seed('PENDING');
      await handle(e05(1, 'SUSPENDED'));
      await handle(e05(2, 'VERIFIED'));
      expect((await reload(pending.id)).frozen).to.equal(true);
    });

    it('payload ผิดรูป ⇒ InvalidMessageError', async () => {
      for (const payload of [
        { ...e05(1, 'VERIFIED').payload, status: 'GONE' },
        { ...e05(1, 'VERIFIED').payload, snapshot: { name: '' } },
        { ...e05(1, 'VERIFIED').payload, company_id: 'abc' },
      ]) {
        let error: unknown;
        await inTx((tx) => companies.handle(envelope('CompanyStatusChanged', 'identity', payload) as never, tx)).catch((e: unknown) => (error = e));
        expect(error).to.be.instanceOf(InvalidMessageError);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('E07 AdvisorLinkChanged', () => {
    let student: string;
    beforeEach(() => {
      student = randomUUID();
    });
    const e07 = (version: number, linkStatus: string, extra: Record<string, unknown> = {}) =>
      envelope('AdvisorLinkChanged', 'identity', {
        student_user_id: student,
        link_status: linkStatus,
        changed_by: 'ADMIN',
        entity_version: version,
        changed_at: new Date().toISOString(),
        ...extra,
      });
    const handle = (env: ReturnType<typeof e07>) => inTx((tx) => links.handle(env as never, tx));
    const seedFor = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
      seed(status, { studentUserId: student, jobId: randomUUID(), ...data });

    it('LINKED ⇒ ย้ายใบที่ยังไม่สิ้นสุด (+รายงานปัญหาที่ยังไม่ปิด) ไปอาจารย์ใหม่ • ใบที่จบ/บันทึกผลวิชาแล้วไม่ย้าย', async () => {
      const newAdvisor = randomUUID();
      // ยืนยันได้ทีละ 1 ที่ (partial unique index) ⇒ ใบที่รอดำเนินการอีกใบใช้ HR_ACCEPTED
      const pending = await seedFor('HR_ACCEPTED');
      const terminated = await seedFor('TERMINATED');
      const recorded = await seedFor('NO_EVALUATION', { academicResult: 'ACADEMIC_FAIL', academicRecordedAt: new Date() });
      const completed = await seedFor('COMPLETED');
      const withdrawn = await seedFor('WITHDRAWN');
      const running = await seedFor('IN_PROGRESS');
      const base = { studentUserId: student, category: 'OTHER' as const, detail: 'x', dueAt: new Date() };
      const openReport = await prisma.problemReport.create({ data: { ...base, applicationId: running.id, advisorUserId: advisor } });
      const closedReport = await prisma.problemReport.create({
        data: { ...base, applicationId: running.id, advisorUserId: advisor, status: 'RESOLVED' },
      });

      await handle(e07(2, 'LINKED', { old_advisor_id: advisor, new_advisor_id: newAdvisor }));

      for (const t of [pending, terminated, running]) expect((await reload(t.id)).advisorUserId, t.status).to.equal(newAdvisor);
      for (const t of [recorded, completed, withdrawn]) expect((await reload(t.id)).advisorUserId, t.status).to.equal(advisor);
      expect((await prisma.problemReport.findUniqueOrThrow({ where: { id: openReport.id } })).advisorUserId).to.equal(newAdvisor);
      expect((await prisma.problemReport.findUniqueOrThrow({ where: { id: closedReport.id } })).advisorUserId).to.equal(advisor);
      expect(await prisma.studentAdvisorLink.findUniqueOrThrow({ where: { studentUserId: student } })).to.include({
        advisorUserId: newAdvisor,
        linkStatus: 'LINKED',
        entityVersion: 2,
      });
    });

    it('ADVISOR_LINK_PENDING ⇒ ใบสมัครค้างอยู่กับอาจารย์เดิม • UNLINKED ⇒ ลิงก์ว่าง • Event เก่า ⇒ ข้าม', async () => {
      const pending = await seedFor('ADVISOR_PENDING');
      await handle(e07(1, 'LINKED', { new_advisor_id: advisor }));
      await handle(e07(2, 'ADVISOR_LINK_PENDING', { old_advisor_id: advisor, new_advisor_id: randomUUID() }));
      expect(await prisma.studentAdvisorLink.findUniqueOrThrow({ where: { studentUserId: student } })).to.include({
        linkStatus: 'ADVISOR_LINK_PENDING',
        advisorUserId: advisor,
      });
      expect((await reload(pending.id)).advisorUserId).to.equal(advisor);

      expect(await handle(e07(2, 'LINKED', { new_advisor_id: randomUUID() }))).to.equal('stale');
      await handle(e07(3, 'UNLINKED', { old_advisor_id: advisor }));
      expect(await prisma.studentAdvisorLink.findUniqueOrThrow({ where: { studentUserId: student } })).to.include({
        linkStatus: 'NONE',
        advisorUserId: null,
        entityVersion: 3,
      });
      expect((await reload(pending.id)).advisorUserId).to.equal(advisor);
    });

    it('LINKED ไม่มี new_advisor_id / link_status ผิด ⇒ InvalidMessageError', async () => {
      for (const env of [e07(1, 'LINKED'), e07(1, 'BROKEN', { new_advisor_id: advisor })]) {
        let error: unknown;
        await handle(env).catch((e: unknown) => (error = e));
        expect(error).to.be.instanceOf(InvalidMessageError);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('E15 UserDeletionRequested', () => {
    const e15 = (userId: string, anonymousId: string, extra: Record<string, unknown> = {}) =>
      envelope('UserDeletionRequested', 'identity', {
        user_id: userId,
        role: 'STUDENT',
        requested_at: new Date().toISOString(),
        mode: 'DELETE_AND_ANONYMIZE',
        anonymous_actor_id: anonymousId,
        ...extra,
      });
    const handle = (env: ReturnType<typeof e15>) => inTx((tx) => deletions.handle(env as never, tx));

    /** นักศึกษาที่มีข้อมูลครบทุกชนิด */
    async function seedStudent() {
      const student = randomUUID();
      const hr = randomUUID();
      const pending = await seed('PENDING', { studentUserId: student, coverLetter: 'สวัสดีครับ' });
      const accepted = await seed('HR_ACCEPTED', { studentUserId: student, jobId: randomUUID(), quotaReserved: true });
      const completed = await seed('COMPLETED', {
        studentUserId: student,
        jobId: randomUUID(),
        actualStartDate: addDays(today(), -80),
        actualEndDate: addDays(today(), -10),
      });
      const resumeKey = `resumes/${randomUUID()}.pdf`;
      storage.objects.set(resumeKey, Buffer.from('%PDF'));
      await prisma.resume.create({ data: { studentUserId: student, objectKey: resumeKey, sizeBytes: 4, isPrimary: true } });
      await prisma.studentProfile.create({ data: { userId: student, major: 'CS', yearLevel: 4, bio: 'ข้อมูลส่วนตัว' } });
      await prisma.studentAdvisorLink.create({ data: { studentUserId: student, advisorUserId: advisor, linkStatus: 'LINKED' } });
      await prisma.evaluation.create({ data: { applicationId: completed.id, round: 1, result: 'PASS', evaluatedBy: hr } });
      const cert = await prisma.certificate.create({
        data: {
          certificateCode: `IP-2569-${randomUUID().slice(0, 8).toUpperCase()}`,
          applicationId: completed.id,
          studentUserId: student,
          companyId,
          holderNameSnapshot: 'สมชาย ใจดี',
          companyNameSnapshot: 'บริษัท',
          jobTitleSnapshot: 'Backend',
          periodStart: addDays(today(), -80),
          periodEnd: addDays(today(), -10),
          actualDays: 70,
          pdfObjectKey: `certificates/${randomUUID()}.pdf`,
          pdfSha256: 'c'.repeat(64),
          issuedBy: hr,
        },
      });
      const reviewBase = { companyId, studentUserId: student, rating: 4, displayMajor: 'CS', displayYear: 4, outcomeLabel: 'PASS' as const };
      const published = await prisma.review.create({
        data: { ...reviewBase, applicationId: completed.id, body: 'ดีมาก', status: 'PUBLISHED', anonymous: false, publishedAt: new Date() },
      });
      const terminatedApp = await seed('TERMINATED', { studentUserId: student, jobId: randomUUID() });
      const held = await prisma.review.create({
        data: { ...reviewBase, applicationId: terminatedApp.id, title: 'หัวข้อ', body: 'เนื้อหาที่รอตรวจ', status: 'HELD', outcomeLabel: 'TERMINATED' },
      });
      await prisma.statusHistory.create({
        data: {
          entity: 'APPLICATION',
          entityId: pending.id,
          toStatus: 'PENDING',
          actorId: student,
          actorRole: 'STUDENT',
          correlationId: randomUUID(),
        },
      });
      return { student, hr, pending, accepted, completed, terminatedApp, resumeKey, cert, published, held };
    }

    it('นักศึกษาลบบัญชี: ยกเลิกใบก่อนขั้นอาจารย์ + คืนโควตา, ลบไฟล์/PII, รีวิว/ใบรับรองไม่ระบุตัวตน, id ⇒ anonymous_actor_id', async () => {
      const s = await seedStudent();
      const anon = randomUUID();
      const outcome = await handle(e15(s.student, anon));
      expect(outcome).to.include({ cancelled: 2, resumesDeleted: 1, reviewsRemoved: 1, certificatesAnonymized: 1 });

      // 1. ใบสมัคร
      for (const id of [s.pending.id, s.accepted.id]) expect(await reload(id)).to.include({ status: 'CANCELLED', studentUserId: anon });
      expect(await reload(s.completed.id)).to.include({ status: 'COMPLETED', studentUserId: anon });
      expect((await reload(s.pending.id)).coverLetter).to.equal(null);
      expect(job.calls.filter((c) => c.op === 'release').map((c) => c.applicationId)).to.deep.equal([s.accepted.id]);
      const cancelHistory = await prisma.statusHistory.findFirstOrThrow({ where: { entityId: s.accepted.id, toStatus: 'CANCELLED' } });
      expect(cancelHistory).to.include({ actorRole: 'SYSTEM', reason: 'USER_DELETED' });

      // 2. ไฟล์ + PII
      expect(storage.deleted).to.deep.equal([s.resumeKey]);
      expect(await prisma.resume.count({ where: { studentUserId: { in: [s.student, anon] } } })).to.equal(0);
      expect(await prisma.studentProfile.count({ where: { userId: s.student } })).to.equal(0);
      expect(await prisma.studentAdvisorLink.count({ where: { studentUserId: s.student } })).to.equal(0);

      // 3. รีวิว
      expect(await prisma.review.findUniqueOrThrow({ where: { id: s.held.id } })).to.include({ status: 'REMOVED', title: null, body: '', studentUserId: anon });
      expect(await prisma.review.findUniqueOrThrow({ where: { id: s.published.id } })).to.include({
        status: 'PUBLISHED',
        anonymous: true,
        body: 'ดีมาก',
        studentUserId: anon,
      });

      // 4. ใบรับรอง
      expect(await prisma.certificate.findUniqueOrThrow({ where: { id: s.cert.id } })).to.include({
        holderNameSnapshot: DELETED_HOLDER_NAME,
        studentUserId: anon,
        status: 'VALID',
        issuedBy: s.hr,
      });

      // 5–6. ไม่เหลือ user id เดิมในฐาน
      expect(await prisma.application.count({ where: { studentUserId: s.student } })).to.equal(0);
      expect(await prisma.statusHistory.count({ where: { actorId: s.student } })).to.equal(0);
      expect(await prisma.statusHistory.count({ where: { actorId: anon, entityId: s.pending.id } })).to.equal(1);
      expect((await prisma.evaluation.findFirstOrThrow({ where: { applicationId: s.completed.id } })).evaluatedBy).to.equal(s.hr);
    });

    it('รับซ้ำ (event_id ใหม่) ⇒ สำเร็จโดยไม่มีอะไรเปลี่ยน', async () => {
      const s = await seedStudent();
      const anon = randomUUID();
      await handle(e15(s.student, anon));
      const historyCount = await prisma.statusHistory.count();
      job.reset();
      const again = await handle(e15(s.student, anon));
      expect(again).to.deep.equal({
        cancelled: 0,
        resumesDeleted: 0,
        reviewsRemoved: 0,
        certificatesAnonymized: 0,
        historyAnonymized: 0,
        auditAnonymized: 0,
      });
      expect(await prisma.statusHistory.count()).to.equal(historyCount);
      expect(job.calls).to.deep.equal([]);
    });

    it('HR / Admin ลบบัญชี: evaluated_by, issued_by, replied_by, unlocked_by และ admin_audit_log.admin_id ⇒ anonymous_actor_id', async () => {
      const s = await seedStudent();
      const admin = randomUUID();
      await prisma.reviewReply.create({ data: { reviewId: s.published.id, companyId, repliedBy: s.hr, body: 'ขอบคุณครับ' } });
      await prisma.reapplyUnlock.create({ data: { studentUserId: randomUUID(), unlockedBy: admin, reason: 'x' } });
      await prisma.adminAuditLog.create({
        data: { adminId: admin, action: 'REAPPLY_UNLOCK', targetType: 'STUDENT', targetId: randomUUID(), correlationId: randomUUID() },
      });

      const hrAnon = randomUUID();
      await handle(e15(s.hr, hrAnon, { role: 'COMPANY_HR', company_id: companyId }));
      expect((await prisma.evaluation.findFirstOrThrow({ where: { applicationId: s.completed.id } })).evaluatedBy).to.equal(hrAnon);
      expect((await prisma.certificate.findUniqueOrThrow({ where: { id: s.cert.id } })).issuedBy).to.equal(hrAnon);
      expect((await prisma.reviewReply.findFirstOrThrow({ where: { reviewId: s.published.id } })).repliedBy).to.equal(hrAnon);
      expect((await reload(s.pending.id)).status).to.equal('PENDING'); // ใบของนักศึกษาไม่ถูกแตะ

      const adminAnon = randomUUID();
      const out = await handle(e15(admin, adminAnon, { role: 'PLATFORM_ADMIN' }));
      expect(out.auditAnonymized).to.equal(1);
      expect(await prisma.adminAuditLog.count({ where: { adminId: admin } })).to.equal(0);
      expect(await prisma.reapplyUnlock.count({ where: { unlockedBy: adminAnon } })).to.equal(1);
    });

    it('Storage ลบไฟล์ไม่ได้ ⇒ throw และ rollback ทั้งหมด (retry ได้)', async () => {
      const s = await seedStudent();
      storage.failDelete = true;
      let error: unknown;
      await handle(e15(s.student, randomUUID())).catch((e: unknown) => (error = e));
      expect(error).to.be.instanceOf(Error);
      expect((await reload(s.pending.id)).status).to.equal('PENDING');
      expect(await prisma.resume.count({ where: { studentUserId: s.student } })).to.equal(1);
      expect(await prisma.statusHistory.count({ where: { actorId: s.student } })).to.equal(1);
    });

    it('payload ผิดรูป ⇒ InvalidMessageError (id เดียวกับ anonymous, mode ผิด, producer อื่น)', async () => {
      const user = randomUUID();
      const envs = [
        e15(user, user),
        e15(user, randomUUID(), { mode: 'SOFT' }),
        e15('x', randomUUID()),
        { ...e15(user, randomUUID()), producer: 'job' as ServiceName },
      ];
      for (const env of envs) {
        let error: unknown;
        await handle(env).catch((e: unknown) => (error = e));
        expect(error).to.be.instanceOf(InvalidMessageError);
      }
    });
  });

  // ------------------------------------------------------------------
  describe('GET /internal/v1/users/{user_id}/deletion-eligibility (Identity)', () => {
    const token = (issuer = 'identity', secret = IDENTITY_SECRET) =>
      `Bearer ${signServiceToken({ issuer, audience: 'lifecycle', secret })}`;
    const check = (userId: string, auth?: string) => {
      const req = request(app.getHttpServer()).get(`/internal/v1/users/${userId}/deletion-eligibility`);
      return auth ? req.set('Authorization', auth) : req;
    };

    it('มีใบสถานะที่บล็อก ⇒ eligible=false + จำนวน • ใบ PENDING/HR_ACCEPTED/สิ้นสุด หรือไม่รู้จักผู้ใช้ ⇒ eligible=true', async () => {
      const student = randomUUID();
      await seed('ADVISOR_PENDING', { studentUserId: student });
      await seed('FAIL_DISPUTED', { studentUserId: student, jobId: randomUUID() });
      await seed('PENDING', { studentUserId: student, jobId: randomUUID() });
      expect((await check(student, token()).expect(200)).body).to.deep.equal({ eligible: false, blocking_application_count: 2 });

      const free = randomUUID();
      await seed('HR_ACCEPTED', { studentUserId: free });
      await seed('COMPLETED', { studentUserId: free, jobId: randomUUID() });
      expect((await check(free, token()).expect(200)).body).to.deep.equal({ eligible: true, blocking_application_count: 0 });
      expect((await check(randomUUID(), token()).expect(200)).body).to.deep.equal({ eligible: true, blocking_application_count: 0 });
    });

    it('ไม่มี Token / Service อื่น / secret ผิด ⇒ 401 • user_id ไม่ใช่ uuid ⇒ 400', async () => {
      await check(randomUUID()).expect(401);
      await check(randomUUID(), token('job', IDENTITY_SECRET)).expect(401);
      await check(randomUUID(), token('identity', 'z'.repeat(40))).expect(401);
      await check('abc', token()).expect(400);
    });
  });
});
