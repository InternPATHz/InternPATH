import { randomUUID } from 'node:crypto';
import type { JwtClaims } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import { QueueModule } from '../../src/queue/queue.module';
import { QueueService } from '../../src/queue/queue.service';
import { ReportModule } from '../../src/report/report.module';
import { ReportService } from '../../src/report/report.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const DETAIL = 'ประกาศนี้เรียกเก็บเงินค่าสมัครจากนักศึกษา';

describe('คำตัดสินรายงานของ Admin: dismiss-report / uphold-report (Postgres จริง)', function () {
  this.timeout(90000);
  let db: TestDatabase;
  let t: TestApp;
  let reports: ReportService;
  let queue: QueueService;
  let admin: { Authorization: string };
  let adminId: string;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [ReportModule, QueueModule], db });
    reports = t.app.get(ReportService);
    queue = t.app.get(QueueService);
    adminId = randomUUID();
    admin = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN', sub: adminId })}` };
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
  const act = (itemId: string, action: 'dismiss-report' | 'uphold-report', body: object = {}) =>
    http().post(`/v1/admin/queue/${itemId}/actions/${action}`).set(admin).send(body);
  const verified = async () => (await t.prisma.outboxEvent.findMany({ where: { type: 'JobVerified' } })).map((o) => o.payload as any);
  const e04 = () => t.prisma.outboxEvent.count({ where: { type: 'ReportThresholdReached' } });

  /** ประกาศ PUBLISHED + ผลตรวจ 1 รายการ (withEval=false ⇒ ไม่เคยมีผลตรวจ) */
  async function job(withEval = true) {
    const jobId = randomUUID();
    const companyId = randomUUID();
    const submissionId = randomUUID();
    await t.prisma.jobSnapshot.create({ data: { jobId, companyId, status: 'PUBLISHED', entityVersion: 1 } });
    if (withEval) {
      await t.prisma.evaluation.create({
        data: {
          jobId, companyId, submissionId, submissionKind: 'NEW', submittedAt: new Date(), content: {}, riskScore: 0, riskLevel: 'LOW',
          decision: 'APPROVE', negatedOnly: false, matchedKeywords: [], reasons: [], companyFlagUnderReview: false, fastTrack: false,
        },
      });
    }
    return { jobId, companyId, submissionId };
  }
  const file = (jobId: string, user: string = randomUUID()) => reports.report(jobId, { category: 'SCAM_OR_FEE', detail: DETAIL }, claims(user)).then(() => user);
  const fileMany = async (jobId: string, n: number) => {
    const users: string[] = [];
    for (let i = 0; i < n; i++) users.push(await file(jobId));
    return users;
  };
  const openItem = (jobId: string) => t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId, type: 'JOB_REPORT', status: 'OPEN' } });
  const streak = async (u: string) => (await t.prisma.reporterStat.findUnique({ where: { userId: u } }))?.consecutiveDismissed ?? 0;

  describe('รายการที่ระงับแล้ว (REPORT_THRESHOLD)', () => {
    it('dismiss ⇒ JobVerified(RESTORE), รายงาน DISMISSED, ตัวนับรีเซ็ต, streak +1 คนละหนึ่ง, ปิดรายการ + status_history + audit', async () => {
      const { jobId, submissionId } = await job();
      const users = await fileMany(jobId, 3);
      const item = await openItem(jobId);
      expect(item.origin).to.equal('REPORT_THRESHOLD');

      await act(item.id, 'dismiss-report', { reason: 'ประกาศปกติ' }).expect(204);

      const out = await verified();
      expect(out).to.have.length(1);
      expect(out[0]).to.include({ job_id: jobId, submission_id: submissionId, decision: 'RESTORE', decided_by: 'ADMIN', is_appeal: false });
      expect(out[0].reasons[0]).to.include({ code: 'REPORT_DISMISSED', detail: 'ประกาศปกติ' });
      expect((await t.prisma.jobReport.findMany({ where: { jobId } })).map((r) => r.status)).to.deep.equal(['DISMISSED', 'DISMISSED', 'DISMISSED']);
      const counter = await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } });
      expect(counter).to.include({ countedReports: 0, suspendedAt: null });
      expect(counter.resetAt).to.be.instanceOf(Date);
      for (const u of users) expect(await streak(u)).to.equal(1);
      expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).to.include({ status: 'RESOLVED', resolution: 'REPORT_DISMISSED' });
      const hist = await t.prisma.statusHistory.findFirstOrThrow({ where: { entityId: item.id, toStatus: 'RESOLVED' } });
      expect(hist).to.include({ actorId: adminId, actorRole: 'PLATFORM_ADMIN', reason: 'ประกาศปกติ' });
      const audit = await t.prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: item.id } });
      expect(audit).to.include({ adminId, action: 'REPORT_DISMISS', targetType: 'queue_item' });

      // ผู้รายงานเดิมรายงานซ้ำไม่ได้ แต่บัญชีใหม่ 3 คนระงับรอบใหม่ได้ (E04 ตัวที่สอง + รายการใหม่)
      let code: string | undefined;
      try {
        await file(jobId, users[0]);
      } catch (e) {
        code = (e as { code?: string }).code;
      }
      expect(code).to.equal('ALREADY_REPORTED');
      await fileMany(jobId, 3);
      expect(await e04()).to.equal(2);
      expect((await openItem(jobId)).id).to.not.equal(item.id);
    });

    it('uphold ⇒ JobVerified(REMOVE), รายงาน UPHELD counted=true, streak ผู้รายงานทุกคน = 0, ปิดรายการ + audit', async () => {
      const { jobId } = await job();
      const users = await fileMany(jobId, 3);
      await t.prisma.reporterStat.create({ data: { userId: users[0], consecutiveDismissed: 2 } });
      const item = await openItem(jobId);

      await act(item.id, 'uphold-report').expect(204);

      const out = await verified();
      expect(out).to.have.length(1);
      expect(out[0]).to.include({ job_id: jobId, decision: 'REMOVE', decided_by: 'ADMIN', is_appeal: false });
      expect(out[0].reasons[0].code).to.equal('REPORT_UPHELD');
      const rows = await t.prisma.jobReport.findMany({ where: { jobId } });
      expect(rows.every((r) => r.status === 'UPHELD' && r.counted)).to.equal(true);
      for (const u of users) expect(await streak(u)).to.equal(0);
      expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).to.include({ status: 'RESOLVED', resolution: 'REPORT_UPHELD' });
      expect((await t.prisma.adminAuditLog.findFirstOrThrow({ where: { targetId: item.id } })).action).to.equal('REPORT_UPHOLD');
    });

    it('ไม่มี submission_id (ประกาศไม่เคยมีผลตรวจ) ⇒ 422 SUBMISSION_UNKNOWN และไม่เปลี่ยนอะไรเลย (rollback)', async () => {
      const { jobId } = await job(false);
      await fileMany(jobId, 3);
      const item = await openItem(jobId);
      const res = await act(item.id, 'dismiss-report');
      expect(res.status).to.equal(422);
      expect(res.body.error.code).to.equal('SUBMISSION_UNKNOWN');
      expect((await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).status).to.equal('OPEN');
      expect(await verified()).to.have.length(0);
      expect((await t.prisma.jobReport.findMany({ where: { jobId } })).every((r) => r.status === 'OPEN')).to.equal(true);
      expect((await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } })).suspendedAt).to.be.instanceOf(Date);
      expect(await t.prisma.adminAuditLog.count()).to.equal(0);
    });
  });

  describe('รายการ "ไม่นับ" (REPORT_UNCOUNTED, ประกาศยังไม่ถูกระงับ)', () => {
    const badUser = async () => {
      const u = randomUUID();
      await t.prisma.reporterStat.create({ data: { userId: u, consecutiveDismissed: 3 } });
      return u;
    };

    it('dismiss ⇒ รายงานทั้งหมดของรอบ DISMISSED, ตัวนับรีเซ็ต, streak +1, ไม่ส่ง JobVerified', async () => {
      const { jobId } = await job();
      const bad = await badUser();
      await file(jobId, bad);
      const item = await openItem(jobId);
      expect(item.origin).to.equal('REPORT_UNCOUNTED');

      await act(item.id, 'dismiss-report').expect(204);

      expect(await verified()).to.have.length(0);
      expect((await t.prisma.jobReport.findFirstOrThrow({ where: { jobId } })).status).to.equal('DISMISSED');
      expect(await streak(bad)).to.equal(4);
      expect(await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } })).to.include({ countedReports: 0, suspendedAt: null });
    });

    it('uphold ที่ยังไม่ถึงเกณฑ์ ⇒ counted=true, UPHELD, streak=0, ตัวนับ=1, ไม่มี REMOVE/E04; รายงานถัดไปของคนนั้นนับ', async () => {
      const { jobId } = await job();
      const bad = await badUser();
      await file(jobId, bad);
      const item = await openItem(jobId);

      await act(item.id, 'uphold-report').expect(204);

      expect(await verified()).to.have.length(0);
      expect(await e04()).to.equal(0);
      const r = await t.prisma.jobReport.findFirstOrThrow({ where: { jobId } });
      expect(r).to.include({ status: 'UPHELD', counted: true });
      expect(await streak(bad)).to.equal(0);
      expect((await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } })).countedReports).to.equal(1);
      const other = await job();
      await file(other.jobId, bad);
      expect((await t.prisma.jobReport.findFirstOrThrow({ where: { jobId: other.jobId } })).counted).to.equal(true);
    });

    it('uphold ที่ทำให้ตัวนับครบ 3 ⇒ ระงับตามปกติ: E04 report_count=3 + รายการ REPORT_THRESHOLD ใหม่ (รายการเดิมปิด)', async () => {
      const { jobId, companyId } = await job();
      await fileMany(jobId, 2);
      const bad = await badUser();
      await file(jobId, bad);
      const item = await openItem(jobId);
      expect(item.origin).to.equal('REPORT_UNCOUNTED');
      expect(await e04()).to.equal(0);

      await act(item.id, 'uphold-report').expect(204);

      expect(await verified()).to.have.length(0); // ไม่มี manual suspend/REMOVE (R5-G02)
      const events = await t.prisma.outboxEvent.findMany({ where: { type: 'ReportThresholdReached' } });
      expect(events).to.have.length(1);
      const next = await openItem(jobId);
      expect(next.id).to.not.equal(item.id);
      expect(next.origin).to.equal('REPORT_THRESHOLD');
      expect(events[0].payload).to.include({ job_id: jobId, company_id: companyId, report_count: 3, queue_item_id: next.id });
      expect((await t.prisma.jobReportCounter.findUniqueOrThrow({ where: { jobId } })).suspendedAt).to.be.instanceOf(Date);
    });
  });

  it('streak ครบ 3 จากการ dismiss จริง: รายงานที่ 4 ไม่นับ; หลัง uphold รายการของมัน streak=0 และรายงานถัดไปนับ', async () => {
    const x = randomUUID();
    for (let k = 0; k < 3; k++) {
      const { jobId } = await job();
      await file(jobId, x);
      await fileMany(jobId, 2);
      await act((await openItem(jobId)).id, 'dismiss-report').expect(204);
    }
    expect(await streak(x)).to.equal(3);

    const fourth = await job();
    await file(fourth.jobId, x);
    expect((await t.prisma.jobReport.findFirstOrThrow({ where: { jobId: fourth.jobId } })).counted).to.equal(false);
    const item = await openItem(fourth.jobId);
    expect(item.origin).to.equal('REPORT_UNCOUNTED');

    await act(item.id, 'uphold-report').expect(204);
    expect(await streak(x)).to.equal(0);
    const fifth = await job();
    await file(fifth.jobId, x);
    expect((await t.prisma.jobReport.findFirstOrThrow({ where: { jobId: fifth.jobId } })).counted).to.equal(true);
  });

  describe('ข้อผิดพลาดและการกดพร้อมกัน', () => {
    it('ชนิดไม่ใช่ JOB_REPORT ⇒ 422 UNSUPPORTED_ITEM_TYPE; ไม่พบ ⇒ 404', async () => {
      const review = await t.prisma.$transaction((tx) =>
        queue.createItem(tx, { type: 'JOB_REVIEW', jobId: randomUUID(), companyId: randomUUID(), submissionId: randomUUID(), riskLevel: 'MEDIUM', fastTrack: false, origin: 'EVALUATION' }),
      );
      for (const action of ['dismiss-report', 'uphold-report'] as const) {
        const res = await act(review.id, action);
        expect(res.status).to.equal(422);
        expect(res.body.error.code).to.equal('UNSUPPORTED_ITEM_TYPE');
      }
      expect((await act(randomUUID(), 'dismiss-report')).status).to.equal(404);
    });

    it('รายการที่ปิดแล้ว ⇒ 409 STATE_CONFLICT และไม่ส่ง JobVerified ตัวที่สอง', async () => {
      const { jobId } = await job();
      await fileMany(jobId, 3);
      const item = await openItem(jobId);
      await act(item.id, 'dismiss-report').expect(204);
      const res = await act(item.id, 'uphold-report');
      expect(res.status).to.equal(409);
      expect(res.body.error.code).to.equal('STATE_CONFLICT');
      expect(await verified()).to.have.length(1);
    });

    it('สอง Admin กดพร้อมกัน ⇒ ผ่านหนึ่ง (204) ล้มหนึ่ง (409) และมี JobVerified ตัวเดียว', async () => {
      const { jobId } = await job();
      await fileMany(jobId, 3);
      const item = await openItem(jobId);
      const [a, b] = await Promise.all([act(item.id, 'dismiss-report'), act(item.id, 'uphold-report')]);
      expect([a.status, b.status].sort()).to.deep.equal([204, 409]);
      expect(await verified()).to.have.length(1);
    });
  });
});
