import { createHash, randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import {
  CertificatePdfRenderer,
  type CertificatePdfInput,
} from '../../src/modules/certificates/certificate-pdf.renderer';
import { CertificatesModule } from '../../src/modules/certificates/certificates.module';
import { HrApplicationsModule } from '../../src/modules/hr-applications/hr-applications.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity, FakeStorage } from '../support/profile-resume-fakes';

/** แอปจริงได้ OutboxWriter จาก MessagingModule และ S3StorageService จาก StorageModule (Global ทั้งคู่) */
const storage = new FakeStorage();

@Global()
@Module({
  providers: [OutboxWriter, { provide: S3StorageService, useValue: storage }],
  exports: [OutboxWriter, S3StorageService],
})
class TestGlobalsModule {}

/** แทน Chromium — คืน "PDF" ที่ต่างกันตามรหัส และจำ input ไว้ตรวจ (PDF จริงอยู่ใน test/integration/certificate-pdf.spec.ts) */
class FakeRenderer extends CertificatePdfRenderer {
  inputs: CertificatePdfInput[] = [];
  fail = false;

  async render(input: CertificatePdfInput): Promise<Buffer> {
    if (this.fail) throw new Error('chromium crashed');
    this.inputs.push(input);
    return Buffer.from(`%PDF-1.7 fake ${input.certificateCode} ${randomUUID()}`, 'latin1');
  }
}

const ymd = (d: Date) => d.toISOString().slice(0, 10);

/*
 * หัวข้อ 1.7 — E-Certificate (api-contract §7.3, §7.5, §7.7; README §5.4) ผ่าน HTTP จริง + Postgres จริง
 * Identity/Job/Storage/PDF เป็นตัวปลอม • ข้ามทั้งชุดเมื่อไม่มี Postgres (เหมือนเทสต์ DB อื่น)
 */
describe('Lifecycle 1.7 — E-Certificate (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  const identity = new FakeIdentity();
  const job = new FakeJobClient();
  const renderer = new FakeRenderer();
  const http = () => request(app.getHttpServer());

  const hrUser = randomUUID();
  const adminUser = randomUUID();
  let student: string;
  let companyId: string;
  let jobId: string;
  const today = () => bangkokToday(new Date());

  const asHr = (company = companyId) =>
    bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: company, company_role: 'MEMBER' });
  const asStudent = (sub = student) => bearer({ role: 'STUDENT', sub });
  const asAdmin = () => bearer({ role: 'PLATFORM_ADMIN', sub: adminUser });

  before(async function () {
    database = await createTestDatabase('lc_cert');
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
        HrApplicationsModule,
        CertificatesModule,
      ],
    })
      .overrideProvider(IdentityInternalClient)
      .useValue(identity)
      .overrideProvider(JobInternalClient)
      .useValue(job)
      .overrideProvider(CertificatePdfRenderer)
      .useValue(renderer)
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
    identity.unavailable = false;
    renderer.inputs = [];
    renderer.fail = false;
    storage.objects.clear();
    storage.deleted = [];
    storage.signed = [];
    student = randomUUID();
    companyId = randomUUID();
    jobId = randomUUID();
    identity.setStudent(student, { full_name: 'ปิ่นมณี น้ำใส' });
    await prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท ทดสอบ จำกัด', status: 'VERIFIED' } });
    await prisma.jobSnapshot.create({
      data: { jobId, companyId, title: 'Backend Intern', status: 'PUBLISHED', targetMajors: [] },
    });
  });

  /** ใบที่ฝึกจริง `days` วันจบเมื่อวาน + ผลประเมินล่าสุด */
  const seedEvaluated = async (
    status: ApplicationStatus = 'EVALUATED_PASS',
    days = 60,
    result: 'PASS' | 'FAIL' = 'PASS',
    data: Record<string, unknown> = {},
  ) => {
    const end = addDays(today(), -1);
    const start = addDays(end, -days);
    const row = await prisma.application.create({
      data: {
        jobId,
        companyId,
        studentUserId: student,
        status,
        startDate: start,
        endDate: end,
        actualStartDate: start,
        actualEndDate: end,
        quotaReserved: true,
        ...data,
      },
    });
    // CHECK `evaluations_reason_required_on_fail` — FAIL ต้องมีเหตุผล
    const reason = result === 'FAIL' ? 'ส่งงานไม่ครบ' : null;
    await prisma.evaluation.create({ data: { applicationId: row.id, round: 1, result, reason, evaluatedBy: hrUser } });
    return row;
  };

  /** นับเฉพาะของนักศึกษาในเทสต์นี้ (ฐานใช้ร่วมกันทั้งชุด) */
  const myCertificates = () => prisma.certificate.count({ where: { studentUserId: student } });
  const myIssuedEvents = async () =>
    (await prisma.outboxEvent.findMany({ where: { type: 'CertificateIssued' } })).filter(
      (e) => (e.payload as { student_user_id?: string }).student_user_id === student,
    ).length;

  const issue = (id: string, token = asHr()) =>
    http().post(`/v1/hr/applications/${id}/certificate`).set('Authorization', token).send({});
  const revokeHr = (id: string, body: Record<string, unknown> = { reason: 'ข้อมูลไม่ถูกต้อง' }, token = asHr()) =>
    http().post(`/v1/hr/certificates/${id}/actions/revoke`).set('Authorization', token).send(body);
  const revokeAdmin = (id: string, body: Record<string, unknown> = { reason: 'บริษัทหลอกลวง' }) =>
    http().post(`/v1/admin/lifecycle/certificates/${id}/actions/revoke`).set('Authorization', asAdmin()).send(body);
  const lookup = (code: string, ip: string = randomUUID()) =>
    http().get(`/v1/public/certificates/${encodeURIComponent(code)}`).set('X-Forwarded-For', ip);

  const issued = async (status: ApplicationStatus = 'EVALUATED_PASS') => {
    const row = await seedEvaluated(status);
    const res = await issue(row.id).expect(201);
    return { application: row, certificate: res.body as { id: string; certificate_code: string } };
  };

  // ------------------------------------------------------------------
  describe('ออกใบรับรอง POST /hr/applications/{id}/certificate (UAT-09)', () => {
    it('EVALUATED_PASS ฝึกจริง ≥ 30 วัน ⇒ 201 + แถว VALID + ไฟล์ใน Private bucket + SHA-256 + status_history + E12', async () => {
      const row = await seedEvaluated('EVALUATED_PASS', 60);
      const res = await issue(row.id).expect(201);

      expect(res.body).to.include({
        company_name: 'บริษัท ทดสอบ จำกัด',
        job_title: 'Backend Intern',
        actual_days: 60,
        status: 'VALID',
      });
      expect(res.body.certificate_code).to.match(/^IP-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(res.body.period).to.deep.equal({ start: ymd(row.actualStartDate!), end: ymd(row.actualEndDate!) });
      expect(res.body).not.to.have.any.keys('pdf_object_key', 'pdf_sha256', 'holder_name', 'student_user_id');

      const cert = await prisma.certificate.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(cert).to.include({
        applicationId: row.id,
        studentUserId: student,
        companyId,
        holderNameSnapshot: 'ปิ่นมณี น้ำใส',
        issuedBy: hrUser,
        status: 'VALID',
      });
      expect(cert.pdfObjectKey).to.match(/^certificates\/[0-9a-f-]{36}\.pdf$/);
      const file = storage.objects.get(cert.pdfObjectKey)!;
      expect(file).to.not.equal(undefined);
      expect(cert.pdfSha256).to.equal(createHash('sha256').update(file).digest('hex'));
      expect(renderer.inputs[0]).to.include({ certificateCode: cert.certificateCode, holderName: 'ปิ่นมณี น้ำใส', actualDays: 60 });

      const history = await prisma.statusHistory.findMany({ where: { entity: 'CERTIFICATE', entityId: cert.id } });
      expect(history).to.have.length(1);
      expect(history[0]).to.include({ fromStatus: null, toStatus: 'VALID', actorId: hrUser, actorRole: 'COMPANY_HR' });

      const events = await prisma.outboxEvent.findMany({ where: { aggregateId: cert.id } });
      expect(events).to.have.length(1);
      expect(events[0].type).to.equal('CertificateIssued');
      expect(events[0].payload).to.deep.equal({
        certificate_id: cert.id,
        application_id: row.id,
        student_user_id: student,
        company_id: companyId,
        issued_by_user_id: hrUser,
        issued_at: cert.issuedAt.toISOString(),
      });
      // ไม่มีชื่อผู้ถือใน Event (ห้ามมีข้อมูลส่วนบุคคล)
      expect(JSON.stringify(events[0].payload)).not.to.include('ปิ่นมณี');
    });

    it('UAT-08 ข้อ 3: ยุติวันที่ 10 ⇒ ประเมินไม่ได้และออกใบไม่ได้ — TERMINATED ⇒ 409, ข้อมูลไม่เปลี่ยน', async () => {
      const row = await seedEvaluated('TERMINATED', 10, 'PASS', { terminatedBy: 'COMPANY', terminateReason: 'x' });
      await prisma.evaluation.deleteMany({ where: { applicationId: row.id } });
      const res = await issue(row.id).expect(409);
      expect(res.body.error.details[0].issue).to.equal('NOT_EVALUATED_PASS');
      expect(await myCertificates()).to.equal(0);
      expect(storage.objects.size).to.equal(0);
    });

    it('EVALUATED_PASS แต่ฝึกจริง 29 วัน ⇒ 422 CERT_MIN_ACTUAL_DAYS ไม่สร้าง PDF', async () => {
      const row = await seedEvaluated('EVALUATED_PASS', 29);
      const res = await issue(row.id).expect(422);
      expect(res.body.error.code).to.equal('CERT_MIN_ACTUAL_DAYS');
      expect(renderer.inputs).to.have.length(0);
    });

    it('TERMINATED ที่ฝึกครบ 30 วันแล้วประเมิน PASS ⇒ ออกได้ตามระยะฝึกจริง (README §5.2.2)', async () => {
      const row = await seedEvaluated('EVALUATED_PASS', 30, 'PASS', { terminatedBy: 'COMPANY', terminateReason: 'ปิดโครงการ' });
      const res = await issue(row.id).expect(201);
      expect(res.body.actual_days).to.equal(30);
    });

    it('COMPLETED ที่บริษัทประเมิน PASS (อาจารย์บันทึกผลก่อน) ⇒ ออกได้; COMPLETED จาก FAIL ⇒ 409', async () => {
      const passed = await seedEvaluated('COMPLETED', 45, 'PASS', { academicResult: 'ACADEMIC_PASS' });
      await issue(passed.id).expect(201);
      const failed = await seedEvaluated('COMPLETED', 45, 'FAIL', { academicResult: 'ACADEMIC_FAIL', jobId: randomUUID() });
      expect((await issue(failed.id).expect(409)).body.error.details[0].issue).to.equal('NOT_EVALUATED_PASS');
    });

    it('EVALUATED_FAIL ⇒ 409', async () => {
      const row = await seedEvaluated('EVALUATED_FAIL', 60, 'FAIL');
      await issue(row.id).expect(409);
    });

    it('ออกซ้ำ ⇒ 409 CERTIFICATE_ALREADY_ISSUED (แม้ใบเดิมถูกเพิกถอนแล้ว) ไม่ทิ้งไฟล์ค้าง', async () => {
      const { application, certificate } = await issued();
      expect((await issue(application.id).expect(409)).body.error.details[0].issue).to.equal('CERTIFICATE_ALREADY_ISSUED');
      await revokeHr(certificate.id).expect(200);
      await issue(application.id).expect(409);
      expect(storage.objects.size).to.equal(1);
    });

    it('กดออกพร้อมกัน 2 ครั้ง ⇒ สำเร็จ 1 ใบ อีกครั้ง 409 และลบไฟล์ของคำขอที่แพ้', async () => {
      const row = await seedEvaluated();
      const results = await Promise.all([issue(row.id), issue(row.id)]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409]);
      expect(await prisma.certificate.count({ where: { applicationId: row.id } })).to.equal(1);
      const cert = await prisma.certificate.findFirstOrThrow({ where: { applicationId: row.id } });
      expect([...storage.objects.keys()]).to.deep.equal([cert.pdfObjectKey]);
      expect(await myIssuedEvents()).to.equal(1);
    });

    it('บริษัทอื่น ⇒ 403 NOT_OWNER_OF_RESOURCE; ไม่มีใบสมัคร ⇒ 404; Role อื่น ⇒ 403 FORBIDDEN_ROLE', async () => {
      const row = await seedEvaluated();
      expect((await issue(row.id, asHr(randomUUID())).expect(403)).body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
      await issue(randomUUID()).expect(404);
      expect((await issue(row.id, asStudent()).expect(403)).body.error.code).to.equal('FORBIDDEN_ROLE');
      await http().post(`/v1/hr/applications/${row.id}/certificate`).expect(401);
    });

    it('Identity ล่ม ⇒ 502 ไม่ออกใบ (ไม่มีชื่อผู้ถือ — fail-closed)', async () => {
      const row = await seedEvaluated();
      identity.unavailable = true;
      await issue(row.id).expect(502);
      expect(await myCertificates()).to.equal(0);
      expect(renderer.inputs).to.have.length(0);
    });

    it('ยังไม่มี snapshot ประกาศ ⇒ 503 JOB_SNAPSHOT_MISSING', async () => {
      const row = await seedEvaluated('EVALUATED_PASS', 60, 'PASS', { jobId: randomUUID() });
      const res = await issue(row.id).expect(503);
      expect(res.body.error).to.include({ code: 'UPSTREAM_UNAVAILABLE' });
      expect(res.body.error.details[0].issue).to.equal('JOB_SNAPSHOT_MISSING');
    });

    it('สร้าง PDF ไม่สำเร็จ ⇒ 500 ไม่มีแถว/ไฟล์/Event', async () => {
      const row = await seedEvaluated();
      renderer.fail = true;
      await issue(row.id).expect(500);
      expect(await myCertificates()).to.equal(0);
      expect(await myIssuedEvents()).to.equal(0);
      expect(storage.objects.size).to.equal(0);
    });
  });

  // ------------------------------------------------------------------
  describe('รายละเอียดของ HR: evaluation? + certificate? + available_actions', () => {
    const detail = (id: string) =>
      http().get(`/v1/hr/applications/${id}`).set('Authorization', asHr()).expect(200);

    it('EVALUATED_PASS ยังไม่ออก ⇒ มี evaluation และ action `certificate`; ออกแล้ว ⇒ มี certificate และไม่มี action', async () => {
      const row = await seedEvaluated();
      await prisma.evaluation.updateMany({ where: { applicationId: row.id }, data: { scoreNote: 'ทำงานดี' } });
      const before = (await detail(row.id)).body;
      // `EvaluationView` ของ contracts (PR #53) — ฟิลด์ชื่อ `score_note` ไม่ใช่ `note`
      expect(before.evaluation).to.include({ round: 1, result: 'PASS', score_note: 'ทำงานดี' });
      expect(before.evaluation).not.to.have.property('note');
      expect(before.available_actions).to.include('certificate');
      expect(before).not.to.have.property('certificate');

      const cert = (await issue(row.id).expect(201)).body;
      const after = (await detail(row.id)).body;
      expect(after.available_actions).not.to.include('certificate');
      // `certificate?` = `CertificateItem` เต็ม เท่ากับผลของการออกใบ
      expect(after.certificate).to.deep.equal(cert);
    });

    it('ใบที่ถูกเพิกถอนยังคืนใน HR detail พร้อม status REVOKED และออกใหม่ไม่ได้ (ไม่มี action `certificate`)', async () => {
      const { application, certificate } = await issued();
      await revokeHr(certificate.id).expect(200);
      const body = (await detail(application.id)).body;
      expect(body.certificate).to.include({ id: certificate.id, status: 'REVOKED' });
      expect(body.available_actions).not.to.include('certificate');
    });

    it('REEVALUATION_REQUESTED ⇒ HR เห็นผลประเมินรอบล่าสุดของตน (round 1 FAIL พร้อมเหตุผล)', async () => {
      const row = await seedEvaluated('REEVALUATION_REQUESTED', 60, 'FAIL', { reevaluationUsed: true });
      await prisma.evaluation.updateMany({ where: { applicationId: row.id }, data: { reason: 'ส่งงานไม่ครบ' } });
      const body = (await detail(row.id)).body;
      expect(body.evaluation).to.include({ round: 1, result: 'FAIL', reason: 'ส่งงานไม่ครบ' });
      expect(body.available_actions).not.to.include('certificate');
    });

    it('ฝึกจริงไม่ถึง 30 วัน ⇒ ไม่มี action `certificate`', async () => {
      const row = await seedEvaluated('EVALUATED_PASS', 20);
      expect((await detail(row.id)).body.available_actions).not.to.include('certificate');
    });
  });

  // ------------------------------------------------------------------
  describe('นักศึกษา GET /me/certificates และ download (UAT-09 ข้อ 3)', () => {
    it('เห็นเฉพาะของตน + Signed URL ~10 นาทีของไฟล์ในใบ', async () => {
      const { certificate } = await issued();
      const list = await http().get('/v1/me/certificates').set('Authorization', asStudent()).expect(200);
      expect(list.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 1 });
      expect(list.body.data[0]).to.include({ id: certificate.id, status: 'VALID' });

      const other = randomUUID();
      const otherList = await http().get('/v1/me/certificates').set('Authorization', asStudent(other)).expect(200);
      expect(otherList.body.data).to.have.length(0);

      const res = await http()
        .get(`/v1/me/certificates/${certificate.id}/download`)
        .set('Authorization', asStudent())
        .expect(200);
      const cert = await prisma.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
      expect(storage.signed.at(-1)).to.deep.equal({ key: cert.pdfObjectKey, ttl: 600 });
      expect(res.body.url).to.include(cert.pdfObjectKey);
      const ttlMs = Date.parse(res.body.expires_at) - Date.now();
      expect(ttlMs).to.be.within(590_000, 600_000);
    });

    it('ใบของคนอื่น ⇒ 404 (ไม่บอกว่ามีอยู่); HR/อาจารย์ ⇒ 403 FORBIDDEN_ROLE', async () => {
      const { certificate } = await issued();
      await http().get(`/v1/me/certificates/${certificate.id}/download`).set('Authorization', asStudent(randomUUID())).expect(404);
      await http().get(`/v1/me/certificates/${certificate.id}/download`).set('Authorization', asHr()).expect(403);
      await http().get('/v1/me/certificates').set('Authorization', bearer({ role: 'ADVISOR' })).expect(403);
    });

    it('ใบที่ถูกเพิกถอน ⇒ ยังเห็นในรายการ (REVOKED) แต่ดาวน์โหลดไม่ได้ 409 CERTIFICATE_REVOKED', async () => {
      const { certificate } = await issued();
      await revokeHr(certificate.id).expect(200);
      const list = await http().get('/v1/me/certificates').set('Authorization', asStudent()).expect(200);
      expect(list.body.data[0].status).to.equal('REVOKED');
      const res = await http().get(`/v1/me/certificates/${certificate.id}/download`).set('Authorization', asStudent()).expect(409);
      expect(res.body.error.details[0].issue).to.equal('CERTIFICATE_REVOKED');
    });
  });

  // ------------------------------------------------------------------
  describe('เพิกถอน (UAT-23)', () => {
    it('HR เพิกถอนใบของบริษัทตน ⇒ REVOKED + status_history + E13; ไม่มี admin_audit_log', async () => {
      const { application, certificate } = await issued();
      const res = await revokeHr(certificate.id, { reason: '  ข้อมูลไม่ถูกต้อง  ' }).expect(200);
      expect(res.body).to.include({ id: certificate.id, status: 'REVOKED' });

      const cert = await prisma.certificate.findUniqueOrThrow({ where: { id: certificate.id } });
      expect(cert).to.include({ status: 'REVOKED', revokedBy: hrUser, revokedByRole: 'COMPANY_HR', revokeReason: 'ข้อมูลไม่ถูกต้อง' });

      const history = await prisma.statusHistory.findMany({
        where: { entity: 'CERTIFICATE', entityId: certificate.id },
        orderBy: { occurredAt: 'asc' },
      });
      expect(history.map((h) => [h.fromStatus, h.toStatus])).to.deep.equal([[null, 'VALID'], ['VALID', 'REVOKED']]);
      expect(history[1]).to.include({ actorRole: 'COMPANY_HR', reason: 'ข้อมูลไม่ถูกต้อง' });

      const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: certificate.id, type: 'CertificateRevoked' } });
      expect(event.payload).to.deep.equal({
        certificate_id: certificate.id,
        application_id: application.id,
        student_user_id: student,
        revoked_by_user_id: hrUser,
        revoked_by_role: 'COMPANY_HR',
        reason: 'ข้อมูลไม่ถูกต้อง',
        revoked_at: cert.revokedAt!.toISOString(),
      });
      expect(await prisma.adminAuditLog.count({ where: { targetId: certificate.id } })).to.equal(0);
    });

    it('HR บริษัทอื่น ⇒ 403; ไม่ระบุเหตุผล ⇒ 400 REASON_REQUIRED; เพิกถอนซ้ำ ⇒ 409 ALREADY_REVOKED; ไม่มี ⇒ 404', async () => {
      const { certificate } = await issued();
      expect((await revokeHr(certificate.id, { reason: 'x' }, asHr(randomUUID())).expect(403)).body.error.code).to.equal(
        'NOT_OWNER_OF_RESOURCE',
      );
      expect((await revokeHr(certificate.id, {}).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      expect((await revokeHr(certificate.id, { reason: '   ' }).expect(400)).body.error.code).to.equal('REASON_REQUIRED');
      await revokeHr(certificate.id).expect(200);
      expect((await revokeHr(certificate.id).expect(409)).body.error.details[0].issue).to.equal('ALREADY_REVOKED');
      await revokeHr(randomUUID()).expect(404);
      await revokeHr(certificate.id, { reason: 'x' }, asStudent()).expect(403);
    });

    it('Admin เพิกถอนใบใดก็ได้ ⇒ REVOKED + admin_audit_log (ผู้กระทำ เป้าหมาย ก่อน-หลัง เหตุผล) + E13 role PLATFORM_ADMIN', async () => {
      const { certificate } = await issued();
      await revokeAdmin(certificate.id).expect(200);
      const audit = await prisma.adminAuditLog.findMany({ where: { targetId: certificate.id } });
      expect(audit).to.have.length(1);
      expect(audit[0]).to.include({ adminId: adminUser, action: 'CERTIFICATE_REVOKE', targetType: 'CERTIFICATE', reason: 'บริษัทหลอกลวง' });
      expect(audit[0].before).to.deep.equal({ status: 'VALID' });
      expect(audit[0].after).to.deep.equal({ status: 'REVOKED' });
      const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: certificate.id, type: 'CertificateRevoked' } });
      expect(event.payload).to.include({ revoked_by_role: 'PLATFORM_ADMIN', revoked_by_user_id: adminUser });
      await revokeAdmin(certificate.id).expect(409);
      await http()
        .post(`/v1/admin/lifecycle/certificates/${certificate.id}/actions/revoke`)
        .set('Authorization', asHr())
        .send({ reason: 'x' })
        .expect(403);
    });

    it('เพิกถอนพร้อมกัน 2 ครั้ง ⇒ สำเร็จ 1 ครั้ง, E13 1 รายการ', async () => {
      const { certificate } = await issued();
      const results = await Promise.all([revokeHr(certificate.id), revokeAdmin(certificate.id)]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([200, 409]);
      expect(await prisma.outboxEvent.count({ where: { aggregateId: certificate.id, type: 'CertificateRevoked' } })).to.equal(1);
    });
  });

  // ------------------------------------------------------------------
  describe('หน้าตรวจสอบสาธารณะ GET /public/certificates/{code} (UAT-23 ข้อ 1, 4)', () => {
    it('ไม่ต้องล็อกอิน ⇒ VALID + ข้อมูลจำกัดเท่านั้น + noindex; หลังเพิกถอน ⇒ REVOKED', async () => {
      const { certificate } = await issued();
      const res = await lookup(certificate.certificate_code).expect(200);
      expect(res.headers['x-robots-tag']).to.include('noindex');
      expect(res.headers['cache-control']).to.equal('no-store');
      expect(Object.keys(res.body).sort()).to.deep.equal(['company_name', 'holder_name', 'job_title', 'period', 'status']);
      expect(res.body).to.include({
        status: 'VALID',
        holder_name: 'ปิ่นมณี น้ำใส',
        company_name: 'บริษัท ทดสอบ จำกัด',
        job_title: 'Backend Intern',
      });
      expect(Object.keys(res.body.period).sort()).to.deep.equal(['end', 'start']);
      // ไม่มี id ภายใน/อีเมล/รหัสนักศึกษา
      const raw = JSON.stringify(res.body);
      expect(raw).not.to.include(student);
      expect(raw).not.to.include(certificate.id);

      await revokeHr(certificate.id).expect(200);
      expect((await lookup(certificate.certificate_code).expect(200)).body.status).to.equal('REVOKED');
    });

    it('ไม่พบ กับ รูปแบบผิด ⇒ 404 รูปแบบเดียวกัน (ต่างกันแค่ correlation_id) และยังมี noindex', async () => {
      const missing = await lookup('IP-2026-ZZZZZZZZ').expect(404);
      const malformed = await lookup('not-a-code').expect(404);
      const strip = (body: { error: Record<string, unknown> }) => ({ ...body.error, correlation_id: undefined });
      expect(strip(missing.body)).to.deep.equal(strip(malformed.body));
      expect(missing.body.error.code).to.equal('NOT_FOUND');
      expect(malformed.headers['x-robots-tag']).to.include('noindex');
    });

    it('เกินเพดานต่อ IP ⇒ 429 RATE_LIMITED + Retry-After; IP อื่นยังใช้ได้', async () => {
      await prisma.configOverride.upsert({
        where: { key: 'PUBLIC_CERT_RATE_LIMIT_PER_MINUTE' },
        create: { key: 'PUBLIC_CERT_RATE_LIMIT_PER_MINUTE', value: '3' },
        update: { value: '3' },
      });
      try {
        const ip = '198.51.100.7';
        for (let i = 0; i < 3; i += 1) await lookup('IP-2026-ZZZZZZZZ', ip).expect(404);
        const limited = await lookup('IP-2026-ZZZZZZZZ', ip).expect(429);
        expect(limited.body.error.code).to.equal('RATE_LIMITED');
        expect(Number(limited.headers['retry-after'])).to.be.within(1, 60);
        await lookup('IP-2026-ZZZZZZZZ', '198.51.100.8').expect(404);
      } finally {
        await prisma.configOverride.deleteMany({ where: { key: 'PUBLIC_CERT_RATE_LIMIT_PER_MINUTE' } });
      }
    });
  });
});
