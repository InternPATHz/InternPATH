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
import { ConductReportsModule } from '../../src/modules/conduct-reports/conduct-reports.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { ALL_CATEGORIES, TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity } from '../support/profile-resume-fakes';

@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class OutboxOnlyModule {}

const DETAIL = 'มาสายติดต่อกัน 4 วันในสัปดาห์นี้ และไม่แจ้งล่วงหน้า';

/*
 * รายงานพฤติกรรมนักศึกษาจากบริษัทถึงอาจารย์ (ผู้ใช้สั่ง 2026-11-26) ผ่าน HTTP จริง + Postgres จริง
 * HR ส่งได้เฉพาะ IN_PROGRESS ของบริษัทตน • อาจารย์ปัจจุบันเห็น/รับทราบ • E19 ใน Outbox • ไม่เปลี่ยนสถานะใบสมัคร
 */
describe('Lifecycle — รายงานพฤติกรรมนักศึกษาจากบริษัท (HTTP + Postgres จริง)', function () {
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
  const hrUser = randomUUID();

  const asHr = (company = companyId, categories = ALL_CATEGORIES) =>
    bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: company, company_role: 'MEMBER', company_categories: categories });
  const asAdvisor = (sub = advisor) => bearer({ role: 'ADVISOR', sub });

  before(async function () {
    database = await createTestDatabase('lc_conduct');
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
        ConductReportsModule,
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
    advisor = randomUUID();
    student = randomUUID();
    companyId = randomUUID();
    identity.students.clear();
    identity.unavailable = false;
    identity.setStudent(student, { full_name: 'สมหญิง ขยัน', advisor_id: advisor, advisor_link_status: 'LINKED' });
    await prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท ทดสอบพฤติกรรม จำกัด', status: 'VERIFIED' } });
  });

  const seed = async (status: ApplicationStatus, data: Record<string, unknown> = {}) => {
    const jobId = randomUUID();
    await prisma.jobSnapshot.create({ data: { jobId, companyId, title: 'Backend Intern', status: 'PUBLISHED', category: 'TECH_IT' } });
    return prisma.application.create({
      data: { jobId, companyId, studentUserId: student, advisorUserId: advisor, status, ...data },
    });
  };
  const report = (id: string, body: Record<string, unknown> = { category: 'ATTENDANCE', detail: DETAIL }, token = asHr()) =>
    http().post(`/v1/hr/applications/${id}/conduct-reports`).set('Authorization', token).send(body);

  it('HR ส่งรายงานของใบ IN_PROGRESS ⇒ 201 + E19 ใน Outbox (ไม่มีรายละเอียด) • สถานะใบสมัครไม่เปลี่ยน • ไม่มี status_history', async () => {
    const app1 = await seed('IN_PROGRESS');
    const res = await report(app1.id).expect(201);
    expect(res.body).to.include({
      application_id: app1.id, student_user_id: student, company_id: companyId, company_name: 'บริษัท ทดสอบพฤติกรรม จำกัด',
      job_title: 'Backend Intern', category: 'ATTENDANCE', detail: DETAIL, status: 'OPEN',
    });
    expect(res.body).to.not.have.property('student_name');
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'ConductReportCreated', aggregateId: res.body.id } });
    expect(event.payload).to.deep.include({ conduct_report_id: res.body.id, application_id: app1.id, advisor_user_id: advisor,
      student_user_id: student, company_id: companyId, category: 'ATTENDANCE' });
    expect(JSON.stringify(event.payload)).to.not.include(DETAIL);
    expect((await prisma.application.findUniqueOrThrow({ where: { id: app1.id } })).status).to.equal('IN_PROGRESS');
    expect(await prisma.statusHistory.count({ where: { entityId: app1.id } })).to.equal(0);
    expect(await prisma.conductReport.findFirstOrThrow({ where: { id: res.body.id } })).to.include({ reportedBy: hrUser });
  });

  it('ไม่ใช่ IN_PROGRESS ⇒ 409 NOT_IN_PROGRESS • ไม่มีอาจารย์ ⇒ ADVISOR_NOT_LINKED • ข้อมูลผิด ⇒ 400 • ไม่บันทึกอะไร', async () => {
    for (const status of ['PENDING', 'ADVISOR_APPROVED', 'TERMINATED', 'COMPLETED'] as const) {
      // ใบที่ยืนยันแล้วของนักศึกษาคนเดียวกันมีได้ใบเดียว (partial unique index) ⇒ ใช้นักศึกษาคนละคน
      const row = await seed(status, { studentUserId: randomUUID() });
      const res = await report(row.id).expect(409);
      expect(res.body.error.details).to.deep.equal([{ issue: 'NOT_IN_PROGRESS' }]);
    }
    const noAdvisor = await seed('IN_PROGRESS', { advisorUserId: null, studentUserId: randomUUID() });
    const linked = await report(noAdvisor.id).expect(409);
    expect(linked.body.error.details).to.deep.equal([{ issue: 'ADVISOR_NOT_LINKED' }]);
    const ok = await seed('IN_PROGRESS');
    for (const body of [
      {}, { category: 'ATTENDANCE' }, { category: 'NOPE', detail: DETAIL }, { category: 'OTHER', detail: 'สั้นไป' },
      { category: 'OTHER', detail: 'x'.repeat(2001) }, { category: 'OTHER', detail: '          ' },
    ]) {
      await report(ok.id, body).expect(400);
    }
    expect(await prisma.conductReport.count({ where: { companyId } })).to.equal(0);
    expect(await prisma.outboxEvent.count({ where: { type: 'ConductReportCreated' } })).to.be.at.most(1); // จากเทสต์ก่อนหน้าเท่านั้น
  });

  it('สิทธิ์: ไม่มี Token 401 • นักศึกษา/อาจารย์ส่งไม่ได้ 403 • HR บริษัทอื่น 403 NOT_OWNER_OF_RESOURCE • HR Member นอกสายงาน 403 • ไม่พบ 404', async () => {
    const row = await seed('IN_PROGRESS');
    await http().post(`/v1/hr/applications/${row.id}/conduct-reports`).send({ category: 'OTHER', detail: DETAIL }).expect(401);
    await report(row.id, undefined, bearer({ role: 'STUDENT', sub: student })).expect(403);
    await report(row.id, undefined, asAdvisor()).expect(403);
    const other = await report(row.id, undefined, asHr(randomUUID())).expect(403);
    expect(other.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
    await report(row.id, undefined, asHr(companyId, ['CORPORATE_SERVICES'])).expect(403);
    await report(randomUUID()).expect(404);
    await http().get(`/v1/hr/applications/${row.id}/conduct-reports`).set('Authorization', asHr(randomUUID())).expect(403);
    expect(await prisma.conductReport.count({ where: { applicationId: row.id } })).to.equal(0);
  });

  it('อาจารย์ปัจจุบันเห็นรายการ (มีชื่อนักศึกษา) กรอง ?status= • รับทราบพร้อมหมายเหตุ ⇒ HR เห็น • ซ้ำ 409 • อาจารย์อื่น 403', async () => {
    const row = await seed('IN_PROGRESS');
    const created = (await report(row.id, { category: 'BEHAVIOR', detail: DETAIL }).expect(201)).body as { id: string };
    // อาจารย์คนอื่นไม่เห็น
    const foreign = await http().get('/v1/advisor/conduct-reports').set('Authorization', asAdvisor(randomUUID())).expect(200);
    expect(foreign.body.meta.total).to.equal(0);

    const open = await http().get('/v1/advisor/conduct-reports?status=OPEN').set('Authorization', asAdvisor()).expect(200);
    expect(open.body.meta.total).to.equal(1);
    expect(open.body.data[0]).to.include({ id: created.id, student_name: 'สมหญิง ขยัน', status: 'OPEN', category: 'BEHAVIOR' });

    const path = `/v1/advisor/conduct-reports/${created.id}/actions/acknowledge`;
    await http().post(path).set('Authorization', asAdvisor(randomUUID())).send({}).expect(403);
    const ack = await http().post(path).set('Authorization', asAdvisor()).send({ note: '  คุยกับนักศึกษาแล้ว  ' }).expect(200);
    expect(ack.body).to.include({ status: 'ACKNOWLEDGED', advisor_note: 'คุยกับนักศึกษาแล้ว' });
    expect(ack.body.acknowledged_at).to.be.a('string');
    const again = await http().post(path).set('Authorization', asAdvisor()).send({}).expect(409);
    expect(again.body.error.details).to.deep.equal([{ issue: 'ALREADY_ACKNOWLEDGED' }]);
    await http().post(`/v1/advisor/conduct-reports/${randomUUID()}/actions/acknowledge`).set('Authorization', asAdvisor()).send({}).expect(404);
    await http().get('/v1/advisor/conduct-reports?status=NOPE').set('Authorization', asAdvisor()).expect(400);
    expect((await http().get('/v1/advisor/conduct-reports?status=OPEN').set('Authorization', asAdvisor()).expect(200)).body.meta.total).to.equal(0);

    const hrList = await http().get(`/v1/hr/applications/${row.id}/conduct-reports`).set('Authorization', asHr()).expect(200);
    expect(hrList.body.data).to.have.length(1);
    expect(hrList.body.data[0]).to.include({ id: created.id, status: 'ACKNOWLEDGED', advisor_note: 'คุยกับนักศึกษาแล้ว' });
    expect(hrList.body.data[0]).to.not.have.property('student_name');
  });

  it('ย้ายอาจารย์ (applications.advisor_user_id เปลี่ยนตาม E07) ⇒ รายงานเดิมไปอยู่กับอาจารย์คนใหม่ • รับทราบพร้อมกัน 2 คำขอ ⇒ สำเร็จครั้งเดียว', async () => {
    const row = await seed('IN_PROGRESS');
    const created = (await report(row.id).expect(201)).body as { id: string };
    const next = randomUUID();
    await prisma.application.update({ where: { id: row.id }, data: { advisorUserId: next } });
    expect((await http().get('/v1/advisor/conduct-reports').set('Authorization', asAdvisor()).expect(200)).body.meta.total).to.equal(0);
    expect((await http().get('/v1/advisor/conduct-reports').set('Authorization', asAdvisor(next)).expect(200)).body.meta.total).to.equal(1);
    await http().post(`/v1/advisor/conduct-reports/${created.id}/actions/acknowledge`).set('Authorization', asAdvisor()).send({}).expect(403);

    const path = `/v1/advisor/conduct-reports/${created.id}/actions/acknowledge`;
    const results = await Promise.all([1, 2].map(() => http().post(path).set('Authorization', asAdvisor(next)).send({})));
    expect(results.map((r) => r.status).sort()).to.deep.equal([200, 409]);
  });
});
