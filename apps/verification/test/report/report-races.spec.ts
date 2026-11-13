import { randomUUID } from 'node:crypto';
import type { JwtClaims } from '@internpath/common';
import { expect } from 'chai';
import { QueueModule } from '../../src/queue/queue.module';
import { ReportModule } from '../../src/report/report.module';
import { ReportResolutionService } from '../../src/report/report-resolution.service';
import { ReportService } from '../../src/report/report.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const DETAIL = 'ประกาศนี้เรียกเก็บเงินค่าสมัครจากนักศึกษา';

describe('รายงานและคำตัดสินที่ทำงานพร้อมกัน (ผลจาก final review) (Postgres จริง)', function () {
  this.timeout(120000);
  let db: TestDatabase;
  let t: TestApp;
  let reports: ReportService;
  let resolution: ReportResolutionService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [ReportModule, QueueModule], db });
    reports = t.app.get(ReportService);
    resolution = t.app.get(ReportResolutionService);
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

  const claims = (sub: string) => ({ sub, role: 'STUDENT' }) as JwtClaims;
  const file = (jobId: string, user: string = randomUUID()) => reports.report(jobId, { category: 'SCAM_OR_FEE', detail: DETAIL }, claims(user));
  async function job() {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await t.prisma.jobSnapshot.create({ data: { jobId, companyId, status: 'PUBLISHED', entityVersion: 1 } });
    await t.prisma.evaluation.create({
      data: {
        jobId, companyId, submissionId: randomUUID(), submissionKind: 'NEW', submittedAt: new Date(), content: {}, riskScore: 0, riskLevel: 'LOW',
        decision: 'APPROVE', negatedOnly: false, matchedKeywords: [], reasons: [], companyFlagUnderReview: false, fastTrack: false,
      },
    });
    return jobId;
  }
  const badUser = async () => {
    const userId = randomUUID();
    await t.prisma.reporterStat.create({ data: { userId, consecutiveDismissed: 3 } });
    return userId;
  };
  const count = (type: string, jobId?: string) =>
    t.prisma.outboxEvent.findMany({ where: { type } }).then((rows) => rows.filter((r) => !jobId || (r.payload as any).job_id === jobId).length);

  it('ผู้ใช้เดียวยิง 20 รายงานพร้อมกันต่างประกาศ ⇒ สำเร็จ 5 ที่เหลือ RATE_LIMITED (โควตา 5/วันต้องไม่รั่วเมื่อขนาน)', async () => {
    const user = randomUUID();
    const jobs: string[] = [];
    for (let i = 0; i < 20; i++) jobs.push(await job());
    const results = await Promise.allSettled(jobs.map((j) => file(j, user)));
    const ok = results.filter((r) => r.status === 'fulfilled');
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(ok, `สำเร็จ ${ok.length}`).to.have.length(5);
    expect(failed.map((f) => f.reason?.code)).to.deep.equal(Array(15).fill('RATE_LIMITED'));
    expect(await t.prisma.jobReport.count({ where: { reporterUserId: user } })).to.equal(5);
  });

  it('รายงานที่ไม่นับ 2 คนของประกาศเดียวพร้อมกัน ⇒ สำเร็จทั้งคู่และมีรายการ JOB_REPORT เดียว (ไม่ชน unique index เป็น 500)', async () => {
    for (let round = 0; round < 8; round++) {
      const jobId = await job();
      const [a, b] = [await badUser(), await badUser()];
      const results = await Promise.allSettled([file(jobId, a), file(jobId, b)]);
      expect(results.filter((r) => r.status === 'rejected'), `รอบ ${round}`).to.have.length(0);
      expect(await t.prisma.queueItem.count({ where: { targetId: jobId, type: 'JOB_REPORT' } })).to.equal(1);
    }
  });

  it('รายงานที่ 3 (นับ) กับ Admin dismiss รายการ "ไม่นับ" พร้อมกัน ⇒ E04 = RESTORE + (รายการระงับที่ยังเปิดอยู่) เสมอ ไม่มีประกาศที่ถูกระงับค้างโดยไม่มีรายการ', async () => {
    for (let round = 0; round < 15; round++) {
      const jobId = await job();
      await file(jobId);
      await file(jobId);
      await file(jobId, await badUser());
      const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId, type: 'JOB_REPORT', status: 'OPEN' } });
      expect(item.origin).to.equal('REPORT_UNCOUNTED');

      const results = await Promise.allSettled([file(jobId), resolution.dismiss(item.id, { sub: randomUUID() })]);
      expect(results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason?.message), `รอบ ${round}`).to.deep.equal([]);

      const e04 = await count('ReportThresholdReached', jobId);
      const restored = (await t.prisma.outboxEvent.findMany({ where: { type: 'JobVerified' } })).filter((o) => (o.payload as any).job_id === jobId && (o.payload as any).decision === 'RESTORE').length;
      const openThreshold = await t.prisma.queueItem.count({ where: { targetId: jobId, type: 'JOB_REPORT', status: 'OPEN', origin: 'REPORT_THRESHOLD' } });
      expect(e04, `รอบ ${round}: E04=${e04} RESTORE=${restored} openThreshold=${openThreshold}`).to.equal(restored + openThreshold);
    }
  });
});
