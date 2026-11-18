import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { SchedulerRegistry } from '@nestjs/schedule';
import { AppException, OutboxWriter, configureApp, signServiceToken } from '@internpath/common';
import type { InternalCompanyMembersResponse, ReminderDuePayload } from '@internpath/contracts';
import { expect } from 'chai';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { RESERVATION_CHECK_MAX_IDS, ReservationCheckModule } from '../../src/internal/reservation-check.controller';
import { SLA_INTERVAL_NAME, SlaSchedulerModule } from '../../src/jobs/sla-scheduler.module';
import { SlaSchedulerService } from '../../src/jobs/sla-scheduler.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { StateMachineModule } from '../../src/state-machine/state-machine.module';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT } from '../support/jwt';
import { FakeIdentity } from '../support/profile-resume-fakes';

/** OutboxWriter มาจาก MessagingModule (Global) ในแอปจริง — เทสต์ไม่ต่อ RabbitMQ จึงให้ตัวเขียนตรง */
@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class OutboxOnlyModule {}

/** Identity ปลอม + รายชื่อสมาชิกบริษัท (`GET companies/{id}/members`) */
class FakeIdentityWithMembers extends FakeIdentity {
  members = new Map<string, InternalCompanyMembersResponse>();
  memberCalls: string[] = [];

  async getCompanyMembers(companyId: string): Promise<InternalCompanyMembersResponse> {
    this.memberCalls.push(companyId);
    if (this.unavailable) throw new AppException('UPSTREAM_UNAVAILABLE', 'identity down', 502);
    return this.members.get(companyId) ?? [];
  }
}

const DAY_MS = 86_400_000;
const JOB_SECRET = 'job-to-lifecycle-test-secret-0123456789abcdef';

/*
 * หัวข้อ 1.10 — SLA Scheduler (README §5.3) + reservation-check (api-contract §9) ผ่าน Postgres จริง + State Machine จริง
 * Identity/Job เป็นตัวปลอม • ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle 1.10 — SLA Scheduler + reservation-check (Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  let scheduler: SlaSchedulerService;
  const identity = new FakeIdentityWithMembers();
  const job = new FakeJobClient();

  let companyId: string;
  let advisor: string;
  const hr1 = randomUUID();
  const hr2 = randomUUID();
  const today = () => bangkokToday(new Date());

  before(async function () {
    database = await createTestDatabase('lc_sla');
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
              LIFECYCLE_SERVICE_SECRET_JOB: JOB_SECRET,
            }),
          ],
        }),
        PrismaModule,
        LifecycleConfigModule,
        InternalModule,
        OutboxOnlyModule,
        StateMachineModule,
        ReservationCheckModule,
        SlaSchedulerModule, // โมดูลจริง (รวม Runner ที่ตั้ง interval ตอนบูต) — ตรวจ DI ของแอปจริง
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
    scheduler = app.get(SlaSchedulerService);
    // Runner ลงทะเบียน interval แล้ว — หยุดไว้ให้เทสต์เรียก runOnce เองเท่านั้น
    const registry = app.get(SchedulerRegistry);
    expect(registry.doesExist('interval', SLA_INTERVAL_NAME)).to.equal(true);
    registry.deleteInterval(SLA_INTERVAL_NAME);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(async () => {
    job.reset();
    identity.unavailable = false;
    identity.memberCalls = [];
    companyId = randomUUID();
    advisor = randomUUID();
    identity.members.set(companyId, [
      { user_id: hr1, member_role: 'OWNER' },
      { user_id: hr2, member_role: 'MEMBER' },
    ]);
    // ใบของเทสต์ก่อนหน้าไม่ปนกับรอบนี้ (Scheduler ตรวจทุกใบในฐาน)
    await prisma.application.updateMany({ where: { status: { not: 'COMPLETED' } }, data: { status: 'COMPLETED' } });
  });

  const seed = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
    prisma.application.create({
      data: {
        jobId: randomUUID(),
        companyId,
        studentUserId: randomUUID(),
        advisorUserId: advisor,
        status,
        ...data,
      },
    });
  /** เปลี่ยนสถานะเมื่อ `days` วันก่อน */
  const ago = (days: number) => new Date(Date.now() - days * DAY_MS);
  const remindersOf = async (id: string) =>
    (await prisma.outboxEvent.findMany({ where: { aggregateId: id, type: 'ReminderDue' } })).map(
      (e) => e.payload as unknown as ReminderDuePayload,
    );
  const ymd = (d: Date) => d.toISOString().slice(0, 10);

  // ------------------------------------------------------------------
  describe('ReminderDue (E14) + reminder_log', () => {
    it('PENDING วัน 3 ⇒ เตือน HR ทุกคนของบริษัท 1 ครั้ง • รันซ้ำ/รันซ้อนพร้อมกันไม่ส่งซ้ำ (UAT-45)', async () => {
      const pending = await seed('PENDING', { statusChangedAt: ago(3) });

      const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
      expect(a.reminded + b.reminded).to.equal(1);
      const again = await scheduler.runOnce();
      expect(again).to.include({ reminded: 0, expired: 0, failed: 0 });

      const reminders = await remindersOf(pending.id);
      expect(reminders).to.have.length(1);
      expect(reminders[0]).to.deep.equal({
        reminder_type: 'HR_RESPOND_PENDING_D3',
        entity_type: 'APPLICATION',
        entity_id: pending.id,
        due_date: ymd(addDays(today(), 0)),
        audience: [
          { user_id: hr1, role: 'COMPANY_HR' },
          { user_id: hr2, role: 'COMPANY_HR' },
        ],
        context: {
          application_id: pending.id,
          days_overdue: 0,
          deadline_at: new Date(addDays(today(), 11).getTime() - 7 * 3_600_000).toISOString(),
        },
      });
      const logs = await prisma.reminderLog.findMany({ where: { entityId: pending.id } });
      expect(logs.map((l) => [l.type, ymd(l.dueDate)])).to.deep.equal([['HR_RESPOND_PENDING_D3', ymd(today())]]);
      expect((await prisma.application.findUniqueOrThrow({ where: { id: pending.id } })).status).to.equal('PENDING');
    });

    it('ขั้นถัดไป (วัน 7) ส่งเป็นรายการใหม่ • ขั้นเก่าที่เลยมาแล้วไม่ส่งย้อนหลัง', async () => {
      const day7 = await seed('PENDING', { statusChangedAt: ago(8) });
      await scheduler.runOnce();
      expect((await remindersOf(day7.id)).map((r) => r.reminder_type)).to.deep.equal(['HR_RESPOND_PENDING_D7']);
    });

    it('ผู้รับตามชนิด: นักศึกษา (HR_ACCEPTED), อาจารย์ (ADVISOR_PENDING / FAIL_DISPUTED), ขั้นแจ้ง Admin ⇒ audience ว่าง (Notification เติม Admin)', async () => {
      const accepted = await seed('HR_ACCEPTED', { statusChangedAt: ago(3), quotaReserved: true });
      const advisorD3 = await seed('ADVISOR_PENDING', { statusChangedAt: ago(3) });
      const advisorD7 = await seed('ADVISOR_PENDING', { statusChangedAt: ago(7) });
      const disputed = await seed('FAIL_DISPUTED', { statusChangedAt: ago(3) });
      const disputeD7 = await seed('FAIL_DISPUTED', { statusChangedAt: ago(7) });

      const run = await scheduler.runOnce();
      expect(run).to.include({ reminded: 5, expired: 0, failed: 0 });
      expect(identity.memberCalls).to.deep.equal([]); // ไม่มีขั้นที่ต้องใช้ HR — ไม่เรียก Identity

      const only = async (id: string) => (await remindersOf(id))[0];
      expect(await only(accepted.id)).to.deep.include({
        reminder_type: 'STUDENT_CONFIRM_D3',
        audience: [{ user_id: accepted.studentUserId, role: 'STUDENT' }],
      });
      expect((await only(advisorD3.id)).audience).to.deep.equal([{ user_id: advisor, role: 'ADVISOR' }]);
      expect(await only(advisorD7.id)).to.deep.include({ reminder_type: 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7', audience: [] });
      expect(await only(disputed.id)).to.deep.include({ reminder_type: 'ADVISOR_DISPUTE_D3' });
      expect(await only(disputeD7.id)).to.deep.include({ reminder_type: 'DISPUTE_ESCALATE_D7', audience: [] });
    });

    it('รอประเมิน / ออกใบรับรอง: IN_PROGRESS วัน 14 แจ้งอาจารย์ • EVALUATED_PASS ที่มีใบแล้วไม่เตือน', async () => {
      const overdue = await seed('IN_PROGRESS', {
        startDate: addDays(today(), -74),
        endDate: addDays(today(), -14),
        actualStartDate: addDays(today(), -74),
      });
      const passedNoCert = await seed('EVALUATED_PASS', {
        statusChangedAt: ago(3),
        actualStartDate: addDays(today(), -63),
        actualEndDate: addDays(today(), -3),
      });
      const passedWithCert = await seed('EVALUATED_PASS', {
        statusChangedAt: ago(3),
        actualStartDate: addDays(today(), -63),
        actualEndDate: addDays(today(), -3),
      });
      await prisma.certificate.create({
        data: {
          certificateCode: `IP-2569-${randomUUID().slice(0, 8).toUpperCase()}`,
          applicationId: passedWithCert.id,
          studentUserId: passedWithCert.studentUserId,
          companyId,
          holderNameSnapshot: 'สมชาย ใจดี',
          companyNameSnapshot: 'บริษัท ทดสอบ',
          jobTitleSnapshot: 'Backend',
          periodStart: addDays(today(), -63),
          periodEnd: addDays(today(), -3),
          actualDays: 60,
          pdfObjectKey: `certificates/${randomUUID()}.pdf`,
          pdfSha256: 'b'.repeat(64),
          issuedBy: hr1,
        },
      });

      await scheduler.runOnce();
      expect(await remindersOf(overdue.id)).to.deep.equal([
        {
          reminder_type: 'EVALUATE_ESCALATE_D14',
          entity_type: 'APPLICATION',
          entity_id: overdue.id,
          due_date: ymd(today()),
          audience: [{ user_id: advisor, role: 'ADVISOR' }],
          context: { application_id: overdue.id, days_overdue: 0 },
        },
      ]);
      expect((await remindersOf(passedNoCert.id)).map((r) => r.reminder_type)).to.deep.equal(['HR_ISSUE_CERT_D3']);
      expect(await remindersOf(passedWithCert.id)).to.deep.equal([]);
    });

    it('Identity ล่มตอนหารายชื่อ HR ⇒ ไม่เขียน reminder_log (failed) แล้วรอบถัดไปส่งได้', async () => {
      const pending = await seed('PENDING', { statusChangedAt: ago(3) });
      identity.unavailable = true;
      expect(await scheduler.runOnce()).to.include({ reminded: 0, failed: 1 });
      expect(await prisma.reminderLog.count({ where: { entityId: pending.id } })).to.equal(0);

      identity.unavailable = false;
      expect(await scheduler.runOnce()).to.include({ reminded: 1, failed: 0 });
      expect(await remindersOf(pending.id)).to.have.length(1);
    });

    it('ใบที่ถูก Freeze (ประกาศถูกซ่อน/บริษัทถูกระงับ) ไม่ถูกเตือนและไม่หมดอายุ', async () => {
      const frozen = await seed('PENDING', { statusChangedAt: ago(20), frozen: true, frozenAt: ago(10) });
      expect(await scheduler.runOnce()).to.include({ scanned: 0, reminded: 0, expired: 0 });
      expect((await prisma.application.findUniqueOrThrow({ where: { id: frozen.id } })).status).to.equal('PENDING');
    });
  });

  // ------------------------------------------------------------------
  describe('EXPIRED (เปลี่ยนสถานะ ไม่ใช่ ReminderDue)', () => {
    it('PENDING วัน 14 ⇒ EXPIRED โดย SYSTEM + status_history + E08 (ไม่มี E14) + reminder_log ชนิด EXPIRED • รันซ้ำไม่ทำซ้ำ', async () => {
      const pending = await seed('PENDING', { statusChangedAt: ago(14) });
      const [a, b] = await Promise.all([scheduler.runOnce(), scheduler.runOnce()]);
      expect(a.expired + b.expired).to.equal(1);
      expect((await scheduler.runOnce()).expired).to.equal(0);

      expect((await prisma.application.findUniqueOrThrow({ where: { id: pending.id } })).status).to.equal('EXPIRED');
      const history = await prisma.statusHistory.findMany({ where: { entityId: pending.id } });
      expect(history.map((h) => [h.fromStatus, h.toStatus, h.actorRole, h.actorId])).to.deep.equal([
        ['PENDING', 'EXPIRED', 'SYSTEM', null],
      ]);
      const events = await prisma.outboxEvent.findMany({ where: { aggregateId: pending.id } });
      expect(events.map((e) => e.type)).to.deep.equal(['ApplicationStatusChanged']);
      const logs = await prisma.reminderLog.findMany({ where: { entityId: pending.id } });
      expect(logs.map((l) => [l.type, ymd(l.dueDate)])).to.deep.equal([['EXPIRED', ymd(today())]]);
      expect(job.calls).to.deep.equal([]); // PENDING ยังไม่จองโควตา
    });

    it('HR_ACCEPTED วัน 5 และ ADVISOR_APPROVED เกิน 14 วันหลัง start_date ⇒ EXPIRED + คืนโควตา (release หลัง commit)', async () => {
      const accepted = await seed('HR_ACCEPTED', { statusChangedAt: ago(5), quotaReserved: true });
      const approved = await seed('ADVISOR_APPROVED', {
        startDate: addDays(today(), -15),
        endDate: addDays(today(), 45),
        quotaReserved: true,
      });
      const notYet = await seed('ADVISOR_APPROVED', {
        startDate: addDays(today(), -14),
        endDate: addDays(today(), 46),
        quotaReserved: true,
      });

      expect(await scheduler.runOnce()).to.include({ expired: 2 });
      for (const id of [accepted.id, approved.id]) {
        const row = await prisma.application.findUniqueOrThrow({ where: { id } });
        expect(row).to.include({ status: 'EXPIRED', quotaReserved: false });
      }
      expect(job.calls.filter((c) => c.op === 'release').map((c) => c.applicationId).sort()).to.deep.equal(
        [accepted.id, approved.id].sort(),
      );
      // วันที่ 14 ยังไม่หมดอายุ — ได้แค่การแจ้งอาจารย์/Admin (เกิน 7 วัน)
      expect((await prisma.application.findUniqueOrThrow({ where: { id: notYet.id } })).status).to.equal('ADVISOR_APPROVED');
      expect((await remindersOf(notYet.id)).map((r) => r.reminder_type)).to.deep.equal(['START_CONFIRM_ESCALATE_D7']);
    });

    it('ADVISOR_PENDING ไม่หมดอายุและไม่อนุมัติอัตโนมัติแม้ค้างนาน', async () => {
      const waiting = await seed('ADVISOR_PENDING', { statusChangedAt: ago(40) });
      await scheduler.runOnce();
      expect((await prisma.application.findUniqueOrThrow({ where: { id: waiting.id } })).status).to.equal('ADVISOR_PENDING');
    });

    it('config_overrides เร่งเวลา (UAT-18/34/47) — SLA_PENDING_DAYS = 1 ⇒ ใบที่สมัครเมื่อวานหมดอายุ', async () => {
      const pending = await seed('PENDING', { statusChangedAt: ago(1) });
      await prisma.configOverride.create({ data: { key: 'SLA_PENDING_DAYS', value: '1' } });
      try {
        expect(await scheduler.runOnce()).to.include({ expired: 1 });
      } finally {
        await prisma.configOverride.delete({ where: { key: 'SLA_PENDING_DAYS' } });
      }
      expect((await prisma.application.findUniqueOrThrow({ where: { id: pending.id } })).status).to.equal('EXPIRED');
    });
  });

  // ------------------------------------------------------------------
  describe('POST /internal/v1/applications/reservation-check (Job)', () => {
    const token = (issuer = 'job', secret = JOB_SECRET) => `Bearer ${signServiceToken({ issuer, audience: 'lifecycle', secret })}`;
    const check = (body: unknown, auth?: string) => {
      // `internal/*` ไม่มี global prefix `v1` (configureApp) — path จริงคือ /internal/v1/...
      const req = request(app.getHttpServer()).post('/internal/v1/applications/reservation-check');
      return (auth ? req.set('Authorization', auth) : req).send(body as object);
    };

    it('Lifecycle ชี้ขาดจาก quota_reserved • ไม่พบใบ ⇒ false • คืนตามลำดับคำขอ', async () => {
      const held = await seed('HR_ACCEPTED', { quotaReserved: true });
      const confirmed = await seed('IN_PROGRESS', { quotaReserved: true });
      const released = await seed('WITHDRAWN', { quotaReserved: false });
      const unknown = randomUUID();

      const res = await check({ application_ids: [released.id, held.id, unknown, confirmed.id, held.id] }, token()).expect(200);
      expect(res.body).to.deep.equal([
        { application_id: released.id, should_hold_quota: false },
        { application_id: held.id, should_hold_quota: true },
        { application_id: unknown, should_hold_quota: false },
        { application_id: confirmed.id, should_hold_quota: true },
        { application_id: held.id, should_hold_quota: true },
      ]);
      expect((await check({ application_ids: [] }, token()).expect(200)).body).to.deep.equal([]);
    });

    it('ไม่มี Token / JWT ของผู้ใช้ / secret ผิด / Service อื่น ⇒ 401 • body ผิด ⇒ 400', async () => {
      expect((await check({ application_ids: [] }).expect(401)).body.error.code).to.equal('UNAUTHENTICATED');
      await check({ application_ids: [] }, token('job', 'x'.repeat(40))).expect(401);
      await check({ application_ids: [] }, token('identity', JOB_SECRET)).expect(401);
      await check({ application_ids: [] }, token('job', JOB_SECRET).replace('Bearer ', 'Bearer x')).expect(401);

      await check({ application_ids: ['not-uuid'] }, token()).expect(400);
      await check({}, token()).expect(400);
      const tooMany = Array.from({ length: RESERVATION_CHECK_MAX_IDS + 1 }, () => randomUUID());
      await check({ application_ids: tooMany }, token()).expect(400);
    });
  });
});
