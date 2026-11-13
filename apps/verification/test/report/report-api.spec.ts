import { randomUUID } from 'node:crypto';
import type { JwtClaims } from '@internpath/common';
import { Logger } from '@nestjs/common';
import { expect } from 'chai';
import request from 'supertest';
import { ReportModule } from '../../src/report/report.module';
import { ReportService } from '../../src/report/report.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const DETAIL = 'ประกาศนี้เรียกเก็บเงินค่าสมัครจากนักศึกษา';

describe('POST /jobs/{job_id}/reports (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: ReportService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [ReportModule], db });
    svc = t.app.get(ReportService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE job_snapshots, job_reports, job_report_counters, reporter_stats, evaluations, queue_items, outbox_events, status_history',
    );
  });

  const http = () => request(t.app.getHttpServer());
  const student = (sub = randomUUID()) => ({ sub, auth: { Authorization: `Bearer ${t.token({ role: 'STUDENT', sub })}` } });
  const seedJob = async (status = 'PUBLISHED', companyId = randomUUID()) => {
    const jobId = randomUUID();
    await t.prisma.jobSnapshot.create({ data: { jobId, companyId, status, entityVersion: 1 } });
    return { jobId, companyId };
  };
  const post = (jobId: string, auth: { Authorization: string }, body: object = { category: 'SCAM_OR_FEE', detail: DETAIL }) =>
    http().post(`/v1/jobs/${jobId}/reports`).set(auth).send(body);
  const claims = (sub: string) => ({ sub, role: 'STUDENT' }) as JwtClaims;
  const outbox = async (type: string) => (await t.prisma.outboxEvent.findMany({ where: { type } })).map((o) => o.payload as any);
  const seedEvaluation = (jobId: string, companyId: string, submissionId: string, submittedAt: Date) =>
    t.prisma.evaluation.create({
      data: {
        jobId, companyId, submissionId, submissionKind: 'NEW', submittedAt, content: {}, riskScore: 0, riskLevel: 'LOW', decision: 'APPROVE',
        negatedOnly: false, matchedKeywords: [], reasons: [], companyFlagUnderReview: false, fastTrack: false,
      },
    });

  it('PUBLISHED และ CLOSED ⇒ 201 {id, status:OPEN}', async () => {
    for (const status of ['PUBLISHED', 'CLOSED']) {
      const { jobId } = await seedJob(status);
      const res = await post(jobId, student().auth);
      expect(res.status, status).to.equal(201);
      expect(res.body).to.have.keys(['id', 'status']);
      expect(res.body.status).to.equal('OPEN');
    }
  });

  it('VERIFYING / SUSPENDED / REMOVED ⇒ 422 JOB_NOT_REPORTABLE; ไม่รู้จักประกาศ ⇒ 404', async () => {
    for (const status of ['VERIFYING', 'SUSPENDED', 'REMOVED']) {
      const { jobId } = await seedJob(status);
      const res = await post(jobId, student().auth);
      expect(res.status, status).to.equal(422);
      expect(res.body.error.code).to.equal('JOB_NOT_REPORTABLE');
    }
    expect((await post(randomUUID(), student().auth)).status).to.equal(404);
  });

  it('ข้อมูลผิดรูป ⇒ 400 VALIDATION_FAILED (detail 19/1001 ตัวอักษร, category นอก enum, ไม่ใช่ uuid)', async () => {
    const { jobId } = await seedJob();
    for (const body of [
      { category: 'SCAM_OR_FEE', detail: 'ก'.repeat(19) },
      { category: 'SCAM_OR_FEE', detail: 'ก'.repeat(1001) },
      { category: 'NOT_A_CATEGORY', detail: DETAIL },
      { detail: DETAIL },
    ]) {
      const res = await post(jobId, student().auth, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).to.equal(400);
      expect(res.body.error.code).to.equal('VALIDATION_FAILED');
    }
    expect((await post(jobId, student().auth, { category: 'OTHER', detail: 'ก'.repeat(20) })).status).to.equal(201);
    expect((await http().post('/v1/jobs/not-a-uuid/reports').set(student().auth).send({ category: 'OTHER', detail: DETAIL })).status).to.equal(400);
  });

  it('รายงานซ้ำ (แม้สถานะรายงานเป็น DISMISSED แล้ว) ⇒ 409 ALREADY_REPORTED', async () => {
    const { jobId } = await seedJob();
    const s = student();
    const first = await post(jobId, s.auth);
    expect(first.status).to.equal(201);
    let res = await post(jobId, s.auth);
    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal('ALREADY_REPORTED');
    await t.prisma.jobReport.updateMany({ where: { jobId }, data: { status: 'DISMISSED' } });
    res = await post(jobId, s.auth);
    expect(res.status).to.equal(409);
    expect(res.body.error.code).to.equal('ALREADY_REPORTED');
  });

  it('สิทธิ์: ไม่มี token 401; HR และ Admin 403', async () => {
    const { jobId } = await seedJob();
    expect((await http().post(`/v1/jobs/${jobId}/reports`).send({ category: 'OTHER', detail: DETAIL })).status).to.equal(401);
    for (const role of ['COMPANY_HR', 'PLATFORM_ADMIN'] as const) {
      const res = await post(jobId, { Authorization: `Bearer ${t.token({ role, sub: randomUUID(), company_id: randomUUID() })}` });
      expect(res.status, role).to.equal(403);
    }
  });

  it('เกิน 5 ครั้ง/วัน ⇒ 429 RATE_LIMITED + Retry-After (วินาที)', async () => {
    const s = student();
    for (let i = 0; i < 5; i++) expect((await post((await seedJob()).jobId, s.auth)).status).to.equal(201);
    const res = await post((await seedJob()).jobId, s.auth);
    expect(res.status).to.equal(429);
    expect(res.body.error.code).to.equal('RATE_LIMITED');
    const retry = Number(res.headers['retry-after']);
    expect(retry).to.be.greaterThan(0).and.lessThan(86_401);
  });

  it('โควตา 5 ครั้ง/วันนับตามปฏิทินไทย: ฉบับที่ 6 ที่ 23:59 ไทยถูกปฏิเสธ แต่ 00:01 ไทยของวันถัดไปผ่าน', async () => {
    const u = randomUUID();
    const before = new Date('2026-11-14T16:59:00Z'); // 23:59 ไทย
    const after = new Date('2026-11-14T17:01:00Z'); // 00:01 ไทย วันถัดไป
    for (let i = 0; i < 5; i++) await svc.report((await seedJob()).jobId, { category: 'OTHER', detail: DETAIL }, claims(u), undefined, before);
    let code: string | undefined;
    try {
      await svc.report((await seedJob()).jobId, { category: 'OTHER', detail: DETAIL }, claims(u), undefined, new Date('2026-11-14T16:59:30Z'));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).to.equal('RATE_LIMITED');
    const ok = await svc.report((await seedJob()).jobId, { category: 'OTHER', detail: DETAIL }, claims(u), undefined, after);
    expect(ok.status).to.equal('OPEN');
  });

  it('รายงานที่ 1-2 นับ counted_reports 1/2 ไม่มี E04 ไม่มีรายการคิว; ที่ 3 ⇒ E04 + JOB_REPORT(REPORT_THRESHOLD) + suspended_at', async () => {
    const { jobId, companyId } = await seedJob();
    const old = randomUUID();
    const latest = randomUUID();
    await seedEvaluation(jobId, companyId, old, new Date('2026-11-10T00:00:00Z'));
    await seedEvaluation(jobId, companyId, latest, new Date('2026-11-12T00:00:00Z'));

    for (let i = 1; i <= 2; i++) {
      expect((await post(jobId, student().auth)).status).to.equal(201);
      expect((await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } })).countedReports).to.equal(i);
    }
    expect(await outbox('ReportThresholdReached')).to.have.length(0);
    expect(await t.prisma.queueItem.count({ where: { targetId: jobId } })).to.equal(0);

    expect((await post(jobId, student().auth)).status).to.equal(201);
    const counter = await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } });
    expect(counter.countedReports).to.equal(3);
    expect(counter.suspendedAt).to.be.instanceOf(Date);
    const items = await t.prisma.queueItem.findMany({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    expect(items).to.have.length(1);
    expect(items[0]).to.include({ origin: 'REPORT_THRESHOLD', priority: 'NORMAL', status: 'OPEN', companyId, submissionId: latest });
    const e04 = await outbox('ReportThresholdReached');
    expect(e04).to.have.length(1);
    expect(e04[0]).to.include({ job_id: jobId, company_id: companyId, report_count: 3, queue_item_id: items[0].id });
    expect(JSON.stringify(e04[0])).to.not.include('reporter');
  });

  it('ประกาศไม่เคยมีผลตรวจ ⇒ รายการ JOB_REPORT submission_id = null', async () => {
    const { jobId } = await seedJob();
    for (let i = 0; i < 3; i++) await post(jobId, student().auth);
    const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    expect(item.submissionId).to.equal(null);
  });

  it('ผู้รายงานที่ถูกยกคำร้องติด 3 ครั้ง ⇒ counted=false ไม่เพิ่มตัวนับ เข้าคิว REPORT_UNCOUNTED ไม่ซ้อน ไม่มี E04 และ response เหมือนกรณีนับ', async () => {
    const { jobId } = await seedJob();
    const bad = student();
    await t.prisma.reporterStat.create({ data: { userId: bad.sub, consecutiveDismissed: 3 } });
    const res = await post(jobId, bad.auth);
    expect(res.status).to.equal(201);
    expect(res.body).to.have.keys(['id', 'status']);
    const report = await t.prisma.jobReport.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(report.counted).to.equal(false);
    expect(await t.prisma.jobReportCounter.findUnique({ where: { jobId } })).to.equal(null);
    const second = student();
    await t.prisma.reporterStat.create({ data: { userId: second.sub, consecutiveDismissed: 4 } });
    await post(jobId, second.auth);
    const items = await t.prisma.queueItem.findMany({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    expect(items).to.have.length(1);
    expect(items[0].origin).to.equal('REPORT_UNCOUNTED');
    expect(await outbox('ReportThresholdReached')).to.have.length(0);
  });

  it('มีรายการ REPORT_UNCOUNTED เปิดอยู่แล้วตอนครบ 3 ⇒ อัปเกรด origin เป็น REPORT_THRESHOLD และ E04 อ้างรายการเดิม', async () => {
    const { jobId } = await seedJob();
    const bad = student();
    await t.prisma.reporterStat.create({ data: { userId: bad.sub, consecutiveDismissed: 3 } });
    await post(jobId, bad.auth);
    const before = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    for (let i = 0; i < 3; i++) await post(jobId, student().auth);
    const items = await t.prisma.queueItem.findMany({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    expect(items).to.have.length(1);
    expect(items[0]).to.include({ id: before.id, origin: 'REPORT_THRESHOLD' });
    expect((await outbox('ReportThresholdReached'))[0].queue_item_id).to.equal(before.id);
  });

  it('ไม่ log detail ของรายงาน', async () => {
    const { jobId } = await seedJob();
    const marker = 'MARKER-ลับ-ห้ามหลุด-1234567890';
    const seen: string[] = [];
    const methods = ['log', 'debug', 'warn', 'error', 'verbose'] as const;
    const originals = methods.map((m) => Logger.prototype[m]);
    methods.forEach((m) => {
      (Logger.prototype as any)[m] = (...args: unknown[]) => void seen.push(args.map((a) => JSON.stringify(a)).join(' '));
    });
    try {
      const res = await post(jobId, student().auth, { category: 'OTHER', detail: `${marker} ${DETAIL}` });
      expect(res.status).to.equal(201); // ต้องผ่านเส้นทางสำเร็จจริง ไม่ใช่ล้มก่อนถึง service
    } finally {
      methods.forEach((m, i) => ((Logger.prototype as any)[m] = originals[i]));
    }
    expect(seen.join('\n')).to.not.include(marker);
  });
});
