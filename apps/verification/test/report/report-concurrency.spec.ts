import { randomUUID } from 'node:crypto';
import type { JwtClaims } from '@internpath/common';
import { expect } from 'chai';
import { ReportModule } from '../../src/report/report.module';
import { ReportService } from '../../src/report/report.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

describe('รายงานพร้อมกัน: รายงานที่ 3 ต้องได้ E04 ครั้งเดียว (Postgres จริง)', function () {
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

  it('6 ผู้ใช้รายงานประกาศเดียวพร้อมกัน ⇒ E04 หนึ่งตัว, JOB_REPORT หนึ่งรายการ, counted_reports = 6, ไม่มี Transaction ล้ม', async () => {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await t.prisma.jobSnapshot.create({ data: { jobId, companyId, status: 'PUBLISHED', entityVersion: 1 } });

    const results = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        svc.report(jobId, { category: 'SCAM_OR_FEE', detail: 'ประกาศนี้เรียกเก็บเงินค่าสมัครจากนักศึกษา' }, { sub: randomUUID(), role: 'STUDENT' } as JwtClaims),
      ),
    );
    const failed = results.filter((r) => r.status === 'rejected').map((r) => (r as PromiseRejectedResult).reason);
    expect(failed, String(failed[0])).to.have.length(0);

    expect(await t.prisma.outboxEvent.count({ where: { type: 'ReportThresholdReached' } })).to.equal(1);
    expect(await t.prisma.queueItem.count({ where: { targetId: jobId, type: 'JOB_REPORT' } })).to.equal(1);
    const counter = await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } });
    expect(counter.countedReports).to.equal(6);
    expect(counter.suspendedAt).to.be.instanceOf(Date);
    expect(await t.prisma.jobReport.count({ where: { jobId } })).to.equal(6);
  });
});
