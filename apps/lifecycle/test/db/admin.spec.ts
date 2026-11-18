import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { AUDIT_ACTIONS } from '../../src/common/audit/admin-audit';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { AdminLifecycleModule } from '../../src/modules/admin/admin-lifecycle.module';
import { ApplicationsModule } from '../../src/modules/applications/applications.module';
import { CertificatePdfRenderer } from '../../src/modules/certificates/certificate-pdf.renderer';
import { CertificatesModule } from '../../src/modules/certificates/certificates.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity, FakeStorage } from '../support/profile-resume-fakes';

/** แอปจริงได้ OutboxWriter จาก MessagingModule และ S3StorageService จาก StorageModule (Global ทั้งคู่) */
@Global()
@Module({
  providers: [OutboxWriter, { provide: S3StorageService, useValue: new FakeStorage() }],
  exports: [OutboxWriter, S3StorageService],
})
class TestGlobalsModule {}

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const BANGKOK_OFFSET_MS = 7 * HOUR_MS;

/*
 * หัวข้อ 1.9 — Admin ของ Lifecycle (api-contract §7.7) ผ่าน HTTP จริง + Postgres จริง + State Machine จริง
 * UAT-22 (NO_EVALUATION), UAT-38 (Audit Log), UAT-39 (รายการรายงานปัญหาของ Admin), UAT-40 (ปลดล็อกสมัครซ้ำ)
 * Identity/Job เป็นตัวปลอม • ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle 1.9 — Admin ของ Lifecycle (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  const identity = new FakeIdentity();
  const job = new FakeJobClient();
  const http = () => request(app.getHttpServer());

  let admin: string;
  let student: string;
  let advisor: string;
  let companyId: string;
  const today = () => bangkokToday(new Date());

  const asAdmin = (sub = admin) => bearer({ role: 'PLATFORM_ADMIN', sub });
  const asStudent = (sub = student) => bearer({ role: 'STUDENT', sub });
  const asAdvisor = () => bearer({ role: 'ADVISOR', sub: advisor });
  const asHr = () => bearer({ role: 'COMPANY_HR', sub: randomUUID(), company_id: companyId, company_role: 'OWNER' });

  before(async function () {
    database = await createTestDatabase('lc_admin');
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
        TestGlobalsModule,
        AdminLifecycleModule,
        ApplicationsModule,
        CertificatesModule,
      ],
    })
      .overrideProvider(IdentityInternalClient)
      .useValue(identity)
      .overrideProvider(JobInternalClient)
      .useValue(job)
      .overrideProvider(CertificatePdfRenderer)
      .useValue({ render: async () => Buffer.from('%PDF-1.7 fake', 'latin1') })
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
    admin = randomUUID();
    student = randomUUID();
    advisor = randomUUID();
    companyId = randomUUID();
    identity.students.clear();
    identity.unavailable = false;
    identity.setStudent(student, { advisor_id: advisor, advisor_link_status: 'LINKED' });
    // ผู้สมัครของรอบก่อนไม่ปนกับรายการ candidates ของรอบนี้
    await prisma.application.updateMany({
      where: { status: { in: ['IN_PROGRESS', 'TERMINATED', 'REEVALUATION_REQUESTED'] } },
      data: { status: 'COMPLETED' },
    });
  });

  /** ใส่ใบสมัครตรง (ข้าม API) เพื่อตั้งสถานะเริ่มต้น */
  const seed = (status: ApplicationStatus, data: Record<string, unknown> = {}) =>
    prisma.application.create({
      data: { jobId: randomUUID(), companyId, studentUserId: student, advisorUserId: advisor, status, ...data },
    });

  /**
   * ฝึกอยู่ — `end_date` เมื่อ `daysAgo` วันก่อน (เริ่มก่อนนั้น 60 วัน)
   * นักศึกษาใหม่ทุกใบ (partial unique index: `IN_PROGRESS` ได้ 1 ใบต่อนักศึกษา)
   */
  const seedInProgress = (daysAgo: number, data: Record<string, unknown> = {}) =>
    seed('IN_PROGRESS', {
      studentUserId: randomUUID(),
      startDate: addDays(today(), -daysAgo - 60),
      endDate: addDays(today(), -daysAgo),
      actualStartDate: addDays(today(), -daysAgo - 60),
      ...data,
    });

  /** ยุติแล้ว — ฝึกจริง `actualDays` วัน สิ้นสุดเมื่อ `daysAgo` วันก่อน */
  const seedTerminated = (daysAgo: number, actualDays: number) =>
    seed('TERMINATED', {
      startDate: addDays(today(), -daysAgo - actualDays),
      endDate: addDays(today(), 30),
      actualStartDate: addDays(today(), -daysAgo - actualDays),
      actualEndDate: addDays(today(), -daysAgo),
      terminatedBy: 'COMPANY',
      terminateReason: 'ปิดโครงการ',
    });

  const seedReevaluation = (statusChangedAt: Date) =>
    seed('REEVALUATION_REQUESTED', {
      startDate: addDays(today(), -90),
      endDate: addDays(today(), -30),
      actualStartDate: addDays(today(), -90),
      actualEndDate: addDays(today(), -30),
      reevaluationUsed: true,
      statusChangedAt,
    });

  const candidates = (query = '', token = asAdmin()) =>
    http().get(`/v1/admin/lifecycle/no-evaluation-candidates${query}`).set('Authorization', token);

  const adminAct = (id: string, action: string, body: Record<string, unknown> = {}, token = asAdmin()) =>
    http().post(`/v1/admin/lifecycle/applications/${id}/actions/${action}`).set('Authorization', token).send(body);

  const unlock = (userId: string, body: Record<string, unknown> = { reason: 'ลงทะเบียนวิชาเลือกเพิ่ม' }, token = asAdmin()) =>
    http().post(`/v1/admin/lifecycle/students/${userId}/reapply-unlock`).set('Authorization', token).send(body);

  const auditOf = (targetId: string) =>
    prisma.adminAuditLog.findMany({ where: { targetId }, orderBy: { occurredAt: 'asc' } });
  const reload = (id: string) => prisma.application.findUniqueOrThrow({ where: { id } });

  // ------------------------------------------------------------------
  describe('Guard สิทธิ์', () => {
    it('ไม่มี Token ⇒ 401 • นักศึกษา/HR/อาจารย์ ⇒ 403 FORBIDDEN_ROLE ทุก endpoint ของ /admin/lifecycle', async () => {
      const id = randomUUID();
      const endpoints: Array<['get' | 'post', string]> = [
        ['get', '/v1/admin/lifecycle/no-evaluation-candidates'],
        ['post', `/v1/admin/lifecycle/applications/${id}/actions/confirm-no-evaluation`],
        ['post', `/v1/admin/lifecycle/applications/${id}/actions/terminate`],
        ['post', `/v1/admin/lifecycle/students/${id}/reapply-unlock`],
        ['get', '/v1/admin/lifecycle/problem-reports'],
        ['get', `/v1/admin/lifecycle/company-stats/${id}`],
        ['get', '/v1/admin/lifecycle/audit-logs'],
      ];
      for (const [method, path] of endpoints) {
        await http()[method](path).expect(401);
        for (const token of [asStudent(), asHr(), asAdvisor()]) {
          const res = await http()[method](path).set('Authorization', token).send({ reason: 'x' });
          expect(res.status, `${method} ${path}`).to.equal(403);
          expect(res.body.error.code).to.equal('FORBIDDEN_ROLE');
        }
      }
    });

    it('id ไม่ใช่ uuid ⇒ 400 • ใบสมัครไม่มีอยู่ ⇒ 404', async () => {
      await adminAct('not-a-uuid', 'terminate', { reason: 'x' }).expect(400);
      await unlock('not-a-uuid').expect(400);
      await http().get('/v1/admin/lifecycle/company-stats/abc').set('Authorization', asAdmin()).expect(400);
      expect((await adminAct(randomUUID(), 'confirm-no-evaluation').expect(404)).body.error.code).to.equal('NOT_FOUND');
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-22 — GET no-evaluation-candidates (ครอบ 3 สถานะ นับเหมือน Guard)', () => {
    it('คืนเฉพาะใบที่ครบ 14 วัน: IN_PROGRESS (end_date), TERMINATED ฝึก ≥ 30 วัน (actual_end_date), REEVALUATION_REQUESTED (วันที่สั่ง)', async () => {
      const inProgress = await seedInProgress(20);
      await prisma.jobSnapshot.create({
        data: { jobId: inProgress.jobId, companyId, status: 'PUBLISHED', title: 'นักศึกษาฝึกงาน Backend' },
      });
      await prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท ทดสอบ จำกัด', status: 'VERIFIED' } });
      const inProgressBoundary = await seedInProgress(14);
      const terminated = await seedTerminated(16, 45);
      const reeval = await seedReevaluation(new Date(Date.now() - 15 * DAY_MS));

      // ไม่ใช่ candidate
      await seedInProgress(13);
      await seedTerminated(30, 29); // ฝึกจริงไม่ถึง 30 วัน
      await seedReevaluation(new Date(Date.now() - 5 * DAY_MS));
      await seed('EVALUATED_PASS', { endDate: addDays(today(), -40) });
      await seed('IN_PROGRESS', { startDate: addDays(today(), -10) }); // ยังไม่มี end_date

      const res = await candidates().expect(200);
      expect(res.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 4 });
      expect(res.body.data.map((c: { id: string }) => c.id)).to.deep.equal([
        inProgress.id,
        terminated.id,
        reeval.id,
        inProgressBoundary.id,
      ]);
      expect(res.body.data.map((c: { days_since_end: number }) => c.days_since_end)).to.deep.equal([20, 16, 15, 14]);
      const first = res.body.data[0];
      expect(first).to.include({
        job_title: 'นักศึกษาฝึกงาน Backend',
        company_name: 'บริษัท ทดสอบ จำกัด',
        status: 'IN_PROGRESS',
        company_id: companyId,
      });
      expect(first).to.not.have.property('student_user_id');
    });

    it('?status= กรอง • สถานะนอก 3 ตัว ⇒ 400 • Pagination ถูกต้อง', async () => {
      await seedInProgress(20);
      await seedInProgress(18);
      const terminated = await seedTerminated(16, 45);

      const onlyTerminated = await candidates('?status=TERMINATED').expect(200);
      expect(onlyTerminated.body.data.map((c: { id: string }) => c.id)).to.deep.equal([terminated.id]);
      await candidates('?status=COMPLETED').expect(400);

      const page2 = await candidates('?page=2&page_size=2').expect(200);
      expect(page2.body.meta).to.deep.equal({ page: 2, page_size: 2, total: 3 });
      expect(page2.body.data.map((c: { id: string }) => c.id)).to.deep.equal([terminated.id]);
    });

    it('REEVALUATION_REQUESTED นับวันตามเวลาไทย — สั่งเมื่อ 00:30 น. ของ 13 วันก่อน (UTC ยังเป็นวันก่อนหน้า) ⇒ ยังไม่ใช่ candidate และยืนยันไม่ได้', async () => {
      // เที่ยงคืนไทยของวัน D = D 00:00 UTC − 7 ชม.
      const changedAt = new Date(addDays(today(), -13).getTime() - BANGKOK_OFFSET_MS + 30 * 60_000);
      const reeval = await seedReevaluation(changedAt);
      expect((await candidates().expect(200)).body.data).to.deep.equal([]);
      const res = await adminAct(reeval.id, 'confirm-no-evaluation').expect(409);
      expect(res.body.error.details).to.deep.include({ issue: 'EVALUATION_NOT_OVERDUE' });
    });

    it('ทุกรายการที่คืนยืนยัน NO_EVALUATION ได้จริง (นับตรงกับ Guard)', async () => {
      await seedInProgress(14);
      await seedTerminated(14, 30);
      await seedReevaluation(new Date(addDays(today(), -14).getTime() - BANGKOK_OFFSET_MS + HOUR_MS));
      const list = (await candidates().expect(200)).body.data as Array<{ id: string }>;
      expect(list).to.have.length(3);
      for (const c of list) {
        expect((await adminAct(c.id, 'confirm-no-evaluation').expect(200)).body.status).to.equal('NO_EVALUATION');
      }
      expect((await candidates().expect(200)).body.meta.total).to.equal(0);
    });

    it('config_overrides SLA_EVALUATION_DAYS ใช้ทั้งรายการและ Guard (ทดสอบ UAT ได้โดยไม่ต้อง Deploy)', async () => {
      const app5 = await seedInProgress(5);
      expect((await candidates().expect(200)).body.meta.total).to.equal(0);
      await prisma.configOverride.create({ data: { key: 'SLA_EVALUATION_DAYS', value: '3' } });
      try {
        const res = await candidates().expect(200);
        expect(res.body.data.map((c: { id: string }) => c.id)).to.deep.equal([app5.id]);
        await adminAct(app5.id, 'confirm-no-evaluation').expect(200);
      } finally {
        await prisma.configOverride.delete({ where: { key: 'SLA_EVALUATION_DAYS' } });
      }
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-22 — POST confirm-no-evaluation', () => {
    it('ครบ 14 วัน ⇒ NO_EVALUATION + status_history (Admin) + E08 + admin_audit_log ใน correlation เดียวกัน', async () => {
      const target = await seedInProgress(15);
      const cid = randomUUID();
      const res = await adminAct(target.id, 'confirm-no-evaluation', { reason: 'โทรติดตามบริษัทแล้ว ไม่ตอบ' })
        .set('X-Correlation-Id', cid)
        .expect(200);
      expect(res.body).to.include({ id: target.id, status: 'NO_EVALUATION' });

      const history = await prisma.statusHistory.findMany({ where: { entityId: target.id } });
      expect(history).to.have.length(1);
      expect(history[0]).to.include({
        fromStatus: 'IN_PROGRESS',
        toStatus: 'NO_EVALUATION',
        actorId: admin,
        actorRole: 'PLATFORM_ADMIN',
        correlationId: cid,
      });
      const outbox = await prisma.outboxEvent.findMany({ where: { aggregateId: target.id } });
      expect(outbox.map((e) => e.type)).to.deep.equal(['ApplicationStatusChanged']);

      const audit = await auditOf(target.id);
      expect(audit).to.have.length(1);
      expect(audit[0]).to.include({
        adminId: admin,
        action: AUDIT_ACTIONS.APPLICATION_CONFIRM_NO_EVALUATION,
        targetType: 'APPLICATION',
        reason: 'โทรติดตามบริษัทแล้ว ไม่ตอบ',
        correlationId: cid,
      });
      expect(audit[0].before).to.deep.equal({ status: 'IN_PROGRESS' });
      expect(audit[0].after).to.deep.equal({ status: 'NO_EVALUATION' });
    });

    it('TERMINATED / REEVALUATION_REQUESTED ⇒ before เป็นสถานะต้นทางจริง • reason ไม่บังคับ', async () => {
      const terminated = await seedTerminated(20, 40);
      const reeval = await seedReevaluation(new Date(Date.now() - 20 * DAY_MS));
      await adminAct(terminated.id, 'confirm-no-evaluation').expect(200);
      await adminAct(reeval.id, 'confirm-no-evaluation').expect(200);
      expect((await auditOf(terminated.id))[0].before).to.deep.equal({ status: 'TERMINATED' });
      const reevalAudit = (await auditOf(reeval.id))[0];
      expect(reevalAudit.before).to.deep.equal({ status: 'REEVALUATION_REQUESTED' });
      expect(reevalAudit.reason).to.equal(null);
    });

    it('ยังไม่ครบ 14 วัน ⇒ 409 EVALUATION_NOT_OVERDUE • TERMINATED ฝึกไม่ถึง 30 วัน ⇒ 422 • สถานะอื่น ⇒ 409 — ไม่มี audit', async () => {
      const early = await seedInProgress(13);
      const short = await seedTerminated(20, 20);
      const pending = await seed('PENDING');

      const res = await adminAct(early.id, 'confirm-no-evaluation').expect(409);
      expect(res.body.error.code).to.equal('STATE_CONFLICT');
      expect(res.body.error.details).to.deep.include({ issue: 'EVALUATION_NOT_OVERDUE' });
      expect((await adminAct(short.id, 'confirm-no-evaluation').expect(422)).body.error.code).to.equal('EVALUATION_NOT_OPEN');
      expect((await adminAct(pending.id, 'confirm-no-evaluation').expect(409)).body.error.code).to.equal('STATE_CONFLICT');

      for (const id of [early.id, short.id, pending.id]) {
        expect(await auditOf(id)).to.deep.equal([]);
        expect((await reload(id)).status).to.not.equal('NO_EVALUATION');
      }
    });

    it('Admin สองคนกดพร้อมกัน ⇒ สำเร็จ 1 (อีกคน 409) และ audit/history อย่างละ 1 แถว', async () => {
      const target = await seedInProgress(20);
      const results = await Promise.all([
        adminAct(target.id, 'confirm-no-evaluation', {}, asAdmin(randomUUID())),
        adminAct(target.id, 'confirm-no-evaluation', {}, asAdmin(randomUUID())),
      ]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([200, 409]);
      expect(await auditOf(target.id)).to.have.length(1);
      expect(await prisma.statusHistory.count({ where: { entityId: target.id } })).to.equal(1);
    });
  });

  // ------------------------------------------------------------------
  describe('POST terminate (terminated_by = ADMIN)', () => {
    it('IN_PROGRESS ⇒ TERMINATED, actual_end_date = วันนี้, เหตุผล + audit (ค่าก่อน-หลัง)', async () => {
      const target = await seedInProgress(-20); // ยังไม่ถึง end_date
      const res = await adminAct(target.id, 'terminate', { reason: '  พบว่าบริษัทหลอกลวง  ' }).expect(200);
      expect(res.body).to.include({ status: 'TERMINATED', actual_end_date: today().toISOString().slice(0, 10) });

      const after = await reload(target.id);
      expect(after).to.include({ terminatedBy: 'ADMIN', terminateReason: 'พบว่าบริษัทหลอกลวง' });
      const history = await prisma.statusHistory.findFirstOrThrow({ where: { entityId: target.id } });
      expect(history).to.include({ actorRole: 'PLATFORM_ADMIN', actorId: admin, reason: 'พบว่าบริษัทหลอกลวง' });

      const audit = await auditOf(target.id);
      expect(audit).to.have.length(1);
      expect(audit[0]).to.include({ action: AUDIT_ACTIONS.APPLICATION_TERMINATE, reason: 'พบว่าบริษัทหลอกลวง' });
      expect(audit[0].before).to.deep.equal({ status: 'IN_PROGRESS' });
      expect(audit[0].after).to.deep.equal({
        status: 'TERMINATED',
        terminated_by: 'ADMIN',
        actual_end_date: today().toISOString().slice(0, 10),
      });
      expect(audit[0].correlationId).to.equal(history.correlationId);
    });

    it('ไม่มีเหตุผล/ช่องว่าง ⇒ 400 REASON_REQUIRED • ไม่ใช่ IN_PROGRESS ⇒ 409 — ไม่มี audit', async () => {
      const target = await seedInProgress(-20);
      expect((await adminAct(target.id, 'terminate', {}).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      expect((await adminAct(target.id, 'terminate', { reason: '   ' }).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      const approved = await seed('ADVISOR_APPROVED', { startDate: addDays(today(), 5), endDate: addDays(today(), 65) });
      expect((await adminAct(approved.id, 'terminate', { reason: 'x' }).expect(409)).body.error.code).to.equal('STATE_CONFLICT');
      expect(await auditOf(target.id)).to.deep.equal([]);
      expect(await auditOf(approved.id)).to.deep.equal([]);
      expect((await reload(target.id)).status).to.equal('IN_PROGRESS');
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-40 — POST students/{user_id}/reapply-unlock', () => {
    const eligibility = () =>
      http().get('/v1/me/application-eligibility').set('Authorization', asStudent()).expect(200);

    it('ผ่านวิชาแล้ว (ถูกบล็อก) ⇒ 201 + สิทธิ์ 1 แถว + audit; นักศึกษาสมัครได้อีกครั้ง', async () => {
      await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS', academicRecordedAt: new Date(Date.now() - DAY_MS) });
      expect((await eligibility()).body).to.deep.equal({ can_apply: false, blocked_reason: 'REAPPLY_BLOCKED' });

      const res = await unlock(student, { reason: '  ลงทะเบียนวิชาเลือกเพิ่ม  ' }).expect(201);
      expect(res.body).to.include({ student_user_id: student, unlocked_by: admin, reason: 'ลงทะเบียนวิชาเลือกเพิ่ม' });
      expect((await eligibility()).body).to.deep.equal({ can_apply: true });

      const rows = await prisma.reapplyUnlock.findMany({ where: { studentUserId: student } });
      expect(rows.map((r) => r.id)).to.deep.equal([res.body.id]);
      const audit = await auditOf(student);
      expect(audit).to.have.length(1);
      expect(audit[0]).to.include({
        adminId: admin,
        action: AUDIT_ACTIONS.REAPPLY_UNLOCK,
        targetType: 'STUDENT',
        reason: 'ลงทะเบียนวิชาเลือกเพิ่ม',
      });
      expect(audit[0].before).to.deep.equal({ reapply_blocked: true });
      expect(audit[0].after).to.deep.equal({ reapply_blocked: false, unlock_id: res.body.id });
    });

    it('มีสิทธิ์ที่ยังไม่ใช้ ⇒ 409 REAPPLY_ALREADY_UNLOCKED • ใช้สิทธิ์แล้ว ⇒ ปลดล็อกใหม่ได้', async () => {
      await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS', academicRecordedAt: new Date(Date.now() - DAY_MS) });
      const first = await unlock(student).expect(201);
      const again = await unlock(student).expect(409);
      expect(again.body.error.code).to.equal('STATE_CONFLICT');
      expect(again.body.error.details).to.deep.include({ issue: 'REAPPLY_ALREADY_UNLOCKED' });

      await prisma.reapplyUnlock.update({ where: { id: first.body.id }, data: { usedAt: new Date() } });
      await unlock(student).expect(201);
      expect(await auditOf(student)).to.have.length(2);
    });

    it('Admin สองคนปลดล็อกพร้อมกัน ⇒ สร้างสิทธิ์ 1 แถว (อีกคน 409)', async () => {
      await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS', academicRecordedAt: new Date(Date.now() - DAY_MS) });
      const results = await Promise.all([
        unlock(student, undefined, asAdmin(randomUUID())),
        unlock(student, undefined, asAdmin(randomUUID())),
      ]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409]);
      expect(await prisma.reapplyUnlock.count({ where: { studentUserId: student } })).to.equal(1);
      expect(await auditOf(student)).to.have.length(1);
    });

    it('ไม่ได้ถูกบล็อก (REPEAT_REQUIRED / ไม่มีใบสมัคร) ⇒ 409 REAPPLY_NOT_BLOCKED • ไม่มีเหตุผล ⇒ 400 REASON_REQUIRED', async () => {
      await seed('COMPLETED', { academicResult: 'REPEAT_REQUIRED', academicRecordedAt: new Date() });
      for (const userId of [student, randomUUID()]) {
        const res = await unlock(userId).expect(409);
        expect(res.body.error.details).to.deep.include({ issue: 'REAPPLY_NOT_BLOCKED' });
      }
      await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS', academicRecordedAt: new Date() });
      expect((await unlock(student, {}).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      expect((await unlock(student, { reason: ' ' }).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      expect(await prisma.reapplyUnlock.count({ where: { studentUserId: student } })).to.equal(0);
      expect(await auditOf(student)).to.deep.equal([]);
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-39 — GET problem-reports (รายการงานของ Admin)', () => {
    it('เห็นรายงานของทุกอาจารย์ เรียง due_at • overdue คำนวณตอนอ่าน • กรอง ?status= / ?overdue=', async () => {
      await prisma.problemReport.deleteMany({});
      const appA = await seedInProgress(-10);
      const appB = await seedInProgress(-10, { advisorUserId: randomUUID(), studentUserId: randomUUID() });
      const base = { category: 'OTHER' as const, detail: 'รายละเอียด' };
      const overdue = await prisma.problemReport.create({
        data: { ...base, applicationId: appA.id, studentUserId: student, advisorUserId: advisor, dueAt: new Date(Date.now() - HOUR_MS) },
      });
      const acknowledged = await prisma.problemReport.create({
        data: {
          ...base,
          applicationId: appB.id,
          studentUserId: appB.studentUserId,
          advisorUserId: appB.advisorUserId,
          status: 'ACKNOWLEDGED',
          dueAt: new Date(Date.now() + 10 * HOUR_MS),
        },
      });
      const resolvedLate = await prisma.problemReport.create({
        data: {
          ...base,
          applicationId: appA.id,
          studentUserId: student,
          advisorUserId: advisor,
          status: 'RESOLVED',
          resolutionNote: 'ติดตามแล้ว',
          dueAt: new Date(Date.now() - 2 * HOUR_MS),
        },
      });

      const list = (q = '') => http().get(`/v1/admin/lifecycle/problem-reports${q}`).set('Authorization', asAdmin()).expect(200);
      const all = await list();
      expect(all.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 3 });
      expect(all.body.data.map((r: { id: string; overdue: boolean }) => [r.id, r.overdue])).to.deep.equal([
        [resolvedLate.id, false],
        [overdue.id, true],
        [acknowledged.id, false],
      ]);
      expect((await list('?overdue=true')).body.data.map((r: { id: string }) => r.id)).to.deep.equal([overdue.id]);
      expect((await list('?overdue=false')).body.meta.total).to.equal(2);
      expect((await list('?status=ACKNOWLEDGED')).body.data.map((r: { id: string }) => r.id)).to.deep.equal([acknowledged.id]);
      await http().get('/v1/admin/lifecycle/problem-reports?overdue=maybe').set('Authorization', asAdmin()).expect(400);
      await http().get('/v1/admin/lifecycle/problem-reports?status=CLOSED').set('Authorization', asAdmin()).expect(400);
    });
  });

  // ------------------------------------------------------------------
  describe('GET company-stats/{company_id}', () => {
    it('นับใบที่ถอนข้อเสนอ และใบที่ถูกยุติ (รวมที่ประเมินต่อหลังยุติ) เฉพาะบริษัทนั้น', async () => {
      await seed('OFFER_RESCINDED', { rescindReason: 'ยกเลิกตำแหน่ง' });
      await seed('OFFER_RESCINDED', { rescindReason: 'ยกเลิกตำแหน่ง' });
      await seedTerminated(3, 10);
      await seed('EVALUATED_PASS', { terminatedBy: 'STUDENT', terminateReason: 'ย้ายที่อยู่' });
      await seed('COMPLETED');
      await prisma.application.create({
        data: { jobId: randomUUID(), companyId: randomUUID(), studentUserId: randomUUID(), status: 'OFFER_RESCINDED' },
      });

      const res = await http().get(`/v1/admin/lifecycle/company-stats/${companyId}`).set('Authorization', asAdmin()).expect(200);
      expect(res.body).to.deep.equal({ company_id: companyId, rescinded_count: 2, terminated_count: 2 });

      const unknown = randomUUID();
      const empty = await http().get(`/v1/admin/lifecycle/company-stats/${unknown}`).set('Authorization', asAdmin()).expect(200);
      expect(empty.body).to.deep.equal({ company_id: unknown, rescinded_count: 0, terminated_count: 0 });
    });
  });

  // ------------------------------------------------------------------
  describe('UAT-38 — GET audit-logs + append-only', () => {
    const logs = (q: string) => http().get(`/v1/admin/lifecycle/audit-logs${q}`).set('Authorization', asAdmin()).expect(200);

    it('ทุกการกระทำของ Admin (ยืนยัน NO_EVALUATION, ยุติ, ปลดล็อก, เพิกถอนใบรับรอง) อยู่ใน audit log ล่าสุดก่อน + กรองได้', async () => {
      const overdue = await seedInProgress(20);
      const running = await seedInProgress(-20);
      await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS', academicRecordedAt: new Date(Date.now() - DAY_MS) });
      const passed = await seed('COMPLETED', {
        actualStartDate: addDays(today(), -80),
        actualEndDate: addDays(today(), -10),
      });
      const cert = await prisma.certificate.create({
        data: {
          certificateCode: `IP-2569-${randomUUID().slice(0, 8).toUpperCase()}`,
          applicationId: passed.id,
          studentUserId: student,
          companyId,
          holderNameSnapshot: 'สมชาย ใจดี',
          companyNameSnapshot: 'บริษัท ทดสอบ จำกัด',
          jobTitleSnapshot: 'Backend',
          periodStart: addDays(today(), -80),
          periodEnd: addDays(today(), -10),
          actualDays: 70,
          pdfObjectKey: `certificates/${randomUUID()}.pdf`,
          pdfSha256: 'a'.repeat(64),
          issuedBy: randomUUID(),
        },
      });

      const before = new Date();
      await adminAct(overdue.id, 'confirm-no-evaluation', { reason: 'ติดตามแล้ว' }).expect(200);
      await adminAct(running.id, 'terminate', { reason: 'บริษัทหลอกลวง' }).expect(200);
      await unlock(student).expect(201);
      await http()
        .post(`/v1/admin/lifecycle/certificates/${cert.id}/actions/revoke`)
        .set('Authorization', asAdmin())
        .send({ reason: 'ข้อมูลไม่ถูกต้อง' })
        .expect(200);

      const mine = await logs(`?actor=${admin}`);
      expect(mine.body.meta.total).to.equal(4);
      expect(mine.body.data.map((e: { action: string }) => e.action)).to.deep.equal([
        'CERTIFICATE_REVOKE',
        'REAPPLY_UNLOCK',
        'APPLICATION_TERMINATE',
        'APPLICATION_CONFIRM_NO_EVALUATION',
      ]);
      const revoke = mine.body.data[0];
      expect(revoke).to.include({ admin_id: admin, target_type: 'CERTIFICATE', target_id: cert.id, reason: 'ข้อมูลไม่ถูกต้อง' });
      expect(revoke.before).to.deep.equal({ status: 'VALID' });
      expect(revoke.after).to.deep.equal({ status: 'REVOKED' });
      expect(revoke.occurred_at).to.match(/^\d{4}-\d{2}-\d{2}T.*Z$/);
      expect(Object.keys(revoke).sort()).to.deep.equal(
        ['action', 'admin_id', 'after', 'before', 'correlation_id', 'id', 'occurred_at', 'reason', 'target_id', 'target_type'].sort(),
      );

      expect((await logs(`?actor=${admin}&action=APPLICATION_TERMINATE`)).body.data.map((e: { target_id: string }) => e.target_id))
        .to.deep.equal([running.id]);
      expect((await logs(`?actor=${admin}&target_type=STUDENT`)).body.data.map((e: { target_id: string }) => e.target_id))
        .to.deep.equal([student]);
      expect((await logs(`?target_id=${overdue.id}`)).body.meta.total).to.equal(1);
      expect((await logs(`?actor=${admin}&from=${before.toISOString()}&page_size=2&page=2`)).body).to.deep.include({
        meta: { page: 2, page_size: 2, total: 4 },
      });
      expect((await logs(`?actor=${admin}&to=${new Date(before.getTime() - 1000).toISOString()}`)).body.meta.total).to.equal(0);
      await http().get('/v1/admin/lifecycle/audit-logs?actor=x').set('Authorization', asAdmin()).expect(400);
      await http().get('/v1/admin/lifecycle/audit-logs?from=yesterday').set('Authorization', asAdmin()).expect(400);
    });

    it('admin_audit_log แก้/ลบไม่ได้ (trigger append-only)', async () => {
      const target = await seedInProgress(20);
      await adminAct(target.id, 'confirm-no-evaluation').expect(200);
      const [row] = await auditOf(target.id);
      let updateError: unknown;
      await prisma.adminAuditLog.update({ where: { id: row.id }, data: { reason: 'แก้ไข' } }).catch((e: unknown) => {
        updateError = e;
      });
      let deleteError: unknown;
      await prisma.adminAuditLog.delete({ where: { id: row.id } }).catch((e: unknown) => {
        deleteError = e;
      });
      expect(updateError, 'UPDATE ต้องถูกปฏิเสธ').to.be.instanceOf(Error);
      expect(deleteError, 'DELETE ต้องถูกปฏิเสธ').to.be.instanceOf(Error);
      expect(await auditOf(target.id)).to.have.length(1);
    });
  });
});
