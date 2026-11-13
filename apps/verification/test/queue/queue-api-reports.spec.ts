import { randomUUID } from 'node:crypto';
import type { JwtClaims } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import { AppealModule } from '../../src/appeal/appeal.module';
import { QueueModule } from '../../src/queue/queue.module';
import { QueueService } from '../../src/queue/queue.service';
import { ReportModule } from '../../src/report/report.module';
import { ReportService } from '../../src/report/report.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const MARKER = 'MARKER-รายละเอียดลับ-9876543210';
const DETAIL = `${MARKER} ประกาศนี้เรียกเก็บเงินค่าสมัครจากนักศึกษา`;

describe('GET /admin/queue/{id} ของ JOB_REPORT + ความเป็นส่วนตัวของผู้รายงาน (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let reports: ReportService;
  let queue: QueueService;
  let admin: { Authorization: string };

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [ReportModule, QueueModule, AppealModule], db });
    reports = t.app.get(ReportService);
    queue = t.app.get(QueueService);
    admin = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN', sub: randomUUID() })}` };
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE job_snapshots, job_reports, job_report_counters, reporter_stats, evaluations, queue_items, outbox_events, status_history, admin_audit_log',
    );
  });

  const http = () => request(t.app.getHttpServer());
  const claims = (sub: string) => ({ sub, role: 'STUDENT' }) as JwtClaims;

  async function reportedJob(n = 3) {
    const jobId = randomUUID();
    const companyId = randomUUID();
    const submissionId = randomUUID();
    await t.prisma.jobSnapshot.create({ data: { jobId, companyId, status: 'PUBLISHED', entityVersion: 1 } });
    await t.prisma.evaluation.create({
      data: {
        jobId, companyId, submissionId, submissionKind: 'NEW', submittedAt: new Date(), content: { job_title: 'ฝึกงานพัฒนาซอฟต์แวร์' },
        riskScore: 0, riskLevel: 'LOW', decision: 'APPROVE', negatedOnly: false, matchedKeywords: [], reasons: [], companyFlagUnderReview: false, fastTrack: false,
      },
    });
    const users: string[] = [];
    for (let i = 0; i < n; i++) {
      const u = randomUUID();
      users.push(u);
      await reports.report(jobId, { category: i === 0 ? 'SCAM_OR_FEE' : 'OTHER', detail: DETAIL }, claims(u));
    }
    return { jobId, companyId, submissionId, users };
  }

  it('Admin เห็น reports[] ครบฟิลด์ใน JOB_REPORT พร้อมเนื้อหาประกาศที่ถูกรายงาน', async () => {
    const { jobId, submissionId, users } = await reportedJob();
    const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    const res = await http().get(`/v1/admin/queue/${item.id}`).set(admin).expect(200);
    expect(res.body).to.include({ id: item.id, type: 'JOB_REPORT', submission_id: submissionId, origin: 'REPORT_THRESHOLD' });
    expect(res.body.content).to.deep.equal({ job_title: 'ฝึกงานพัฒนาซอฟต์แวร์' });
    expect(res.body.reports).to.have.length(3);
    expect(res.body.reports[0]).to.have.all.keys('id', 'reporter_user_id', 'category', 'detail', 'counted', 'status', 'created_at');
    expect(res.body.reports.map((r: any) => r.reporter_user_id)).to.have.members(users);
    expect(res.body.reports[0]).to.include({ category: 'SCAM_OR_FEE', detail: DETAIL, counted: true, status: 'OPEN' });
  });

  it('รายการชนิดอื่น (JOB_REVIEW) ⇒ reports เป็น []', async () => {
    const item = await t.prisma.$transaction((tx) =>
      queue.createItem(tx, { type: 'JOB_REVIEW', jobId: randomUUID(), companyId: randomUUID(), submissionId: randomUUID(), riskLevel: 'MEDIUM', fastTrack: false, origin: 'EVALUATION' }),
    );
    const res = await http().get(`/v1/admin/queue/${item.id}`).set(admin).expect(200);
    expect(res.body.reports).to.deep.equal([]);
  });

  it('นักศึกษา/HR/ไม่มี token เรียกรายละเอียดคิวและ action ของรายงานไม่ได้ (401/403)', async () => {
    const { jobId } = await reportedJob();
    const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId, type: 'JOB_REPORT' } });
    const student = { Authorization: `Bearer ${t.token({ role: 'STUDENT', sub: randomUUID() })}` };
    const hr = { Authorization: `Bearer ${t.token({ role: 'COMPANY_HR', sub: randomUUID(), company_id: randomUUID() })}` };
    const calls: Array<['get' | 'post', string]> = [
      ['get', `/v1/admin/queue/${item.id}`],
      ['post', `/v1/admin/queue/${item.id}/actions/dismiss-report`],
      ['post', `/v1/admin/queue/${item.id}/actions/uphold-report`],
    ];
    for (const [m, url] of calls) {
      await (http() as any)[m](url).expect(401);
      await (http() as any)[m](url).set(student).expect(403);
      await (http() as any)[m](url).set(hr).expect(403);
    }
  });

  it('ตัวตนผู้รายงานและ detail ไม่รั่ว: ผลตรวจของ HR ไม่มี reports/reporter_user_id/detail และ Event ใน outbox ไม่มีสตริงเหล่านี้', async () => {
    const { jobId, companyId, users } = await reportedJob();
    const hr = { Authorization: `Bearer ${t.token({ role: 'COMPANY_HR', sub: randomUUID(), company_id: companyId })}` };
    const res = await http().get(`/v1/verification/jobs/${jobId}/result`).set(hr).expect(200);
    const body = JSON.stringify(res.body);
    for (const leak of ['reports', 'reporter_user_id', 'detail', MARKER, ...users]) expect(body, leak).to.not.include(leak);

    const events = await t.prisma.outboxEvent.findMany();
    expect(events.length).to.be.greaterThan(0);
    const all = JSON.stringify(events.map((e) => e.payload));
    for (const leak of ['reporter_user_id', '"detail":"' + MARKER, MARKER, ...users]) expect(all, leak).to.not.include(leak);
  });
});
