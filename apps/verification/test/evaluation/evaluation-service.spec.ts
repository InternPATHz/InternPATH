import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { EvaluationModule } from '../../src/evaluation/evaluation.module';
import { EvaluationService } from '../../src/evaluation/evaluation.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { envelope, statusChanged, submitted, submittedEnv } from '../support/events';

describe('EvaluationService: คัดกรองประกาศของบริษัทที่ติดธง (Postgres จริง — ไม่มีคะแนน/คำต้องห้ามแล้ว)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: EvaluationService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [EvaluationModule], db });
    svc = t.app.get(EvaluationService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE job_submission_snapshots, queue_items, outbox_events');
  });

  const submit = (p: ReturnType<typeof submitted>) => t.prisma.$transaction((tx) => svc.handleJobSubmitted(submittedEnv(p), tx));
  const timeout = (p: ReturnType<typeof statusChanged>) =>
    t.prisma.$transaction((tx) => svc.handleJobStatusChanged(envelope('JobStatusChanged', p), tx));
  const items = () => t.prisma.queueItem.findMany({ orderBy: { createdAt: 'asc' } });
  const outbox = () => t.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  describe('E01 JobSubmitted', () => {
    it('เก็บสำเนาเนื้อหา, สร้างรายการ JOB_REVIEW (FLAGGED_COMPANY, NORMAL, due +48 ชม.), ส่ง JobVerified PENDING_REVIEW และไม่มีคะแนน', async () => {
      const p = submitted();
      await submit(p);

      const snaps = await t.prisma.jobSubmissionSnapshot.findMany();
      expect(snaps).to.have.length(1);
      expect(snaps[0]).to.include({ submissionId: p.submission_id, jobId: p.job_id, fastTrack: false });

      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({
        type: 'JOB_REVIEW',
        targetId: p.job_id,
        companyId: p.company_id,
        submissionId: p.submission_id,
        origin: 'FLAGGED_COMPANY',
        priority: 'NORMAL',
        status: 'OPEN',
      });
      expect(all[0].dueAt.getTime() - all[0].createdAt.getTime()).to.equal(48 * 3600_000);
      expect(await t.prisma.statusHistory.count({ where: { entityId: all[0].id } })).to.equal(1);

      const out = await outbox();
      expect(out).to.have.length(1);
      const payload = out[0].payload as any;
      expect(out[0].type).to.equal('JobVerified');
      expect(payload).to.include({ job_id: p.job_id, submission_id: p.submission_id, decision: 'PENDING_REVIEW', decided_by: 'SYSTEM' });
      expect(payload).to.not.have.any.keys('risk_score', 'risk_level', 'is_appeal');
    });

    it('เนื้อหาที่เก็บผ่าน normalizeText (ไม่มีอักขระความกว้างศูนย์) และไม่ตัดสินจากเนื้อหา (มีเบอร์โทร/คำต้องห้ามก็เข้าคิวเหมือนกัน)', async () => {
      const p = submitted({}, { description: 'ต้องจ่าย\u200bค่ามัดจำ โทร 081-234-5678' });
      await submit(p);
      const snap = await t.prisma.jobSubmissionSnapshot.findFirstOrThrow();
      expect((snap.content as any).description).to.equal('ต้องจ่ายค่ามัดจำ โทร 081-234-5678');
      expect((await outbox())[0].payload).to.include({ decision: 'PENDING_REVIEW' });
    });

    it('fast_track=true → priority FAST_TRACK, due_at +12 ชม.', async () => {
      await submit(submitted({ fast_track: true }));
      const [item] = await items();
      expect(item.priority).to.equal('FAST_TRACK');
      expect(item.dueAt.getTime() - item.createdAt.getTime()).to.equal(12 * 3600_000);
    });

    it('ส่ง submission_id เดิมซ้ำ → ยังสำเนา/คิว/outbox อย่างละหนึ่งแถว', async () => {
      const p = submitted();
      await submit(p);
      await submit(p);
      expect(await t.prisma.jobSubmissionSnapshot.count()).to.equal(1);
      expect(await items()).to.have.length(1);
      expect(await outbox()).to.have.length(1);
    });

    it('เรียกพร้อมกัน 2 ครั้งด้วย submission_id เดียวกัน → ไม่เกิน 1 แถวและไม่ reject', async () => {
      const p = submitted();
      await Promise.all([submit(p), submit(p)]);
      expect(await t.prisma.jobSubmissionSnapshot.count()).to.equal(1);
      expect(await items()).to.have.length(1);
      expect(await outbox()).to.have.length(1);
    });

    it('E01 EDIT ใหม่ขณะมีรายการเปิดอยู่ → รายการเดิม RESOLVED(SUPERSEDED) ไม่ส่ง Event จากการปิด; รอบใหม่สร้างรายการใหม่ได้', async () => {
      const first = submitted();
      await submit(first);
      const second = submitted({ job_id: first.job_id, company_id: first.company_id, submission_kind: 'EDIT', submitted_at: new Date(Date.now() + 1000).toISOString() });
      await submit(second);

      const all = await items();
      expect(all).to.have.length(2);
      expect(all[0]).to.include({ status: 'RESOLVED', resolution: 'SUPERSEDED', submissionId: first.submission_id });
      expect(all[1]).to.include({ status: 'OPEN', submissionId: second.submission_id, origin: 'FLAGGED_COMPANY' });
      expect((await outbox()).map((o) => (o.payload as any).submission_id)).to.deep.equal([first.submission_id, second.submission_id]);
    });

    it('E01 ของรอบเก่าที่มาถึงช้ากว่ารอบใหม่ → เก็บสำเนาไว้ แต่ไม่ปิดรายการของรอบใหม่และไม่ส่ง JobVerified', async () => {
      const fresh = submitted({ submission_kind: 'EDIT' });
      await submit(fresh);
      const stale = submitted({ job_id: fresh.job_id, company_id: fresh.company_id, submitted_at: ago(60_000) });
      await submit(stale);

      expect(await t.prisma.jobSubmissionSnapshot.count()).to.equal(2);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ status: 'OPEN', submissionId: fresh.submission_id });
      expect(await outbox()).to.have.length(1);
    });
  });

  describe('E03 VERIFY_TIMEOUT', () => {
    it('สร้างรายการ JOB_REVIEW origin VERIFY_TIMEOUT ผูก submission_id จาก E03, SLA +48 ชม., ไม่ส่ง Event', async () => {
      const p = statusChanged({ submission_id: randomUUID() });
      await timeout(p);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ type: 'JOB_REVIEW', targetId: p.job_id, submissionId: p.submission_id!, origin: 'VERIFY_TIMEOUT', priority: 'NORMAL' });
      expect(all[0].dueAt.getTime() - all[0].createdAt.getTime()).to.equal(48 * 3600_000);
      expect(await outbox()).to.have.length(0);
    });

    it('Event ซ้ำ → ยังรายการเดียว; E03 อื่น (to_status/reason_code อื่น) → ไม่มีผล', async () => {
      const p = statusChanged({ submission_id: randomUUID() });
      await timeout(p);
      await timeout(p);
      await timeout(statusChanged({ to_status: 'PUBLISHED', from_status: 'VERIFYING', reason_code: undefined }));
      await timeout(statusChanged({ reason_code: 'REPORT_THRESHOLD' }));
      expect(await items()).to.have.length(1);
    });

    it('E01 มาหลัง VERIFY_TIMEOUT ของ submission เดียวกัน → ผูกกับรายการเดิม ไม่ส่ง JobVerified และไม่เพิ่มรายการ', async () => {
      const p = submitted({ submitted_at: ago(6 * 60_000) });
      await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id, submission_id: p.submission_id }));
      await submit(p);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ origin: 'VERIFY_TIMEOUT', status: 'OPEN', submissionId: p.submission_id });
      expect(await outbox()).to.have.length(0);
    });

    it('E03 ไม่มี submission_id: E01 ที่ส่งก่อนหมดเวลา → แนบและเติม submission_id; E03 ไม่เดา submission จากรอบเก่า', async () => {
      const p = submitted({ submitted_at: ago(6 * 60_000) });
      await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id }));
      expect((await items())[0].submissionId).to.equal(null);
      await submit(p);
      expect((await items())[0].submissionId).to.equal(p.submission_id);

      const other = submitted({ fast_track: true });
      await submit(other);
      await t.prisma.queueItem.updateMany({ where: { targetId: other.job_id }, data: { status: 'RESOLVED' } });
      await timeout(statusChanged({ job_id: other.job_id, company_id: other.company_id }));
      const last = (await items()).find((i) => i.targetId === other.job_id && i.status === 'OPEN')!;
      expect(last).to.include({ submissionId: null, priority: 'NORMAL' });
    });

    it('E01 คนละ submission (ส่งใหม่หลังหมดเวลา) → รายการ timeout ถูก SUPERSEDED และส่ง JobVerified ตามปกติ', async () => {
      const old = submitted({ submitted_at: ago(6 * 60_000) });
      await timeout(statusChanged({ job_id: old.job_id, company_id: old.company_id, submission_id: old.submission_id }));
      const fresh = submitted({ job_id: old.job_id, company_id: old.company_id, submission_kind: 'EDIT' });
      await submit(fresh);

      const all = await items();
      expect(all.filter((i) => i.status === 'RESOLVED')).to.have.length(1);
      expect(all.find((i) => i.status === 'OPEN')).to.include({ submissionId: fresh.submission_id });
      const out = await outbox();
      expect(out).to.have.length(1);
      expect((out[0].payload as any).submission_id).to.equal(fresh.submission_id);
    });
  });
});
