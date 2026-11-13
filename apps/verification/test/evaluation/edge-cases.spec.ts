import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { EvaluationModule } from '../../src/evaluation/evaluation.module';
import { EvaluationService } from '../../src/evaluation/evaluation.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { LONG, PHONE, envelope, statusChanged, submitted, submittedEnv } from '../support/events';

describe('EvaluationService: VERIFY_TIMEOUT และกรณีขอบของ E01 (Postgres จริง)', function () {
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
    await t.prisma.$executeRawUnsafe('TRUNCATE evaluations, queue_items, outbox_events');
  });

  const submit = (p: ReturnType<typeof submitted>) => t.prisma.$transaction((tx) => svc.handleJobSubmitted(submittedEnv(p), tx));
  const timeout = (p: ReturnType<typeof statusChanged>) =>
    t.prisma.$transaction((tx) => svc.handleJobStatusChanged(envelope('JobStatusChanged', p), tx));
  const items = () => t.prisma.queueItem.findMany({ orderBy: { createdAt: 'asc' } });
  const outbox = () => t.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });
  const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

  describe('E01 ใหม่ขณะมีรายการคิวเปิดอยู่ (supersede)', () => {
    it('E01 EDIT ใหม่ → รายการเดิม RESOLVED(SUPERSEDED) ไม่ส่ง Event จากการปิด; ผลใหม่ PENDING_REVIEW สร้างรายการใหม่ได้ (ไม่ชน partial unique)', async () => {
      const first = submitted({}, { description: LONG + PHONE });
      await submit(first);
      const second = submitted(
        { job_id: first.job_id, company_id: first.company_id, submission_kind: 'EDIT', submitted_at: new Date(Date.now() + 1000).toISOString() },
        { description: LONG + PHONE + ' ต่อ 123' },
      );
      await submit(second);

      const all = await items();
      expect(all).to.have.length(2);
      expect(all[0]).to.include({ status: 'RESOLVED', resolution: 'SUPERSEDED', submissionId: first.submission_id });
      expect(all[0].resolvedAt).to.be.instanceOf(Date);
      expect(all[1]).to.include({ status: 'OPEN', submissionId: second.submission_id, origin: 'EVALUATION' });

      const out = await outbox();
      expect(out).to.have.length(2); // JobVerified ของแต่ละรอบเท่านั้น
      expect(out.map((o) => (o.payload as any).submission_id)).to.deep.equal([first.submission_id, second.submission_id]);

      const hist = await t.prisma.statusHistory.findMany({ where: { entityId: all[0].id }, orderBy: { occurredAt: 'asc' } });
      expect(hist.map((h) => [h.fromStatus, h.toStatus, h.reason])).to.deep.equal([
        [null, 'OPEN', 'EVALUATION'],
        ['OPEN', 'RESOLVED', 'SUPERSEDED'],
      ]);
    });

    it('E01 ใหม่ที่ผลเป็น APPROVE ก็ปิดรายการเปิดเดิมเป็น SUPERSEDED เช่นกัน', async () => {
      const first = submitted({}, { description: LONG + PHONE });
      await submit(first);
      await submit(submitted({ job_id: first.job_id, company_id: first.company_id, submitted_at: new Date(Date.now() + 1000).toISOString() }));
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ status: 'RESOLVED', resolution: 'SUPERSEDED' });
    });
  });

  describe('E03 VERIFY_TIMEOUT', () => {
    it('ไม่มีผลตรวจ → รายการ JOB_REVIEW origin VERIFY_TIMEOUT, risk_level ว่าง, submission_id จาก E03, SLA +48 ชม., status_history 1 แถว', async () => {
      const p = statusChanged({ submission_id: randomUUID() });
      await timeout(p);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({
        type: 'JOB_REVIEW',
        targetId: p.job_id,
        companyId: p.company_id,
        submissionId: p.submission_id!,
        riskLevel: null,
        origin: 'VERIFY_TIMEOUT',
        priority: 'NORMAL',
        status: 'OPEN',
      });
      expect(all[0].dueAt.getTime() - all[0].createdAt.getTime()).to.equal(48 * 3600_000);
      expect(await t.prisma.statusHistory.count({ where: { entityId: all[0].id } })).to.equal(1);
      expect(await t.prisma.outboxEvent.count()).to.equal(0);
    });

    it('Event ซ้ำ (คนละ event_id) → ยังรายการเดียว', async () => {
      const p = statusChanged({ submission_id: randomUUID() });
      await timeout(p);
      await timeout(p);
      expect(await items()).to.have.length(1);
    });

    it('E03 อื่น (to_status PUBLISHED / reason_code อื่น / ไม่มี reason_code) → ไม่มีผล', async () => {
      await timeout(statusChanged({ to_status: 'PUBLISHED', from_status: 'VERIFYING', reason_code: undefined }));
      await timeout(statusChanged({ reason_code: 'REPORT_THRESHOLD' }));
      await timeout(statusChanged({ reason_code: undefined }));
      expect(await items()).to.have.length(0);
    });

    it('มีผลตรวจอยู่แล้วแต่ Job หมดเวลาไปก่อน → รายการใช้ risk_level และ fast_track จากผลตรวจนั้น', async () => {
      const p = submitted({ fast_track: true });
      await submit(p); // APPROVE (ไม่มีรายการ)
      await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id, submission_id: p.submission_id }));
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ riskLevel: 'LOW', priority: 'FAST_TRACK', origin: 'VERIFY_TIMEOUT', submissionId: p.submission_id });
    });

    it('ผลตรวจตัดสิน PENDING_REVIEW ไปก่อน แล้ว timeout E03 มาทีหลัง → ใช้รายการเดิม ไม่ซ้ำ', async () => {
      const p = submitted({}, { description: LONG + PHONE });
      await submit(p);
      await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id, submission_id: p.submission_id }));
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0].origin).to.equal('EVALUATION');
    });
  });

  describe('E01 ของรอบเก่าที่มาถึงช้ากว่ารอบใหม่ (stale — ผลรีวิว #1)', () => {
    it('รอบเก่า (submitted_at น้อยกว่า) มาทีหลัง: บันทึกผลไว้ แต่ไม่ปิดรายการของรอบใหม่และไม่ส่ง JobVerified', async () => {
      const jobId = randomUUID();
      const companyId = randomUUID();
      const newer = submitted({ job_id: jobId, company_id: companyId, submitted_at: new Date(Date.now() + 1000).toISOString() }, { description: LONG + PHONE });
      const older = submitted({ job_id: jobId, company_id: companyId, submitted_at: new Date(Date.now() - 1000).toISOString() });
      await submit(newer);
      await submit(older);

      expect(await t.prisma.evaluation.count()).to.equal(2);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ status: 'OPEN', submissionId: newer.submission_id });
      const out = await outbox();
      expect(out).to.have.length(1);
      expect((out[0].payload as any).submission_id).to.equal(newer.submission_id);
    });

    it('รอบเก่าที่ผลเป็น PENDING_REVIEW ก็ไม่สร้างรายการใหม่ที่ชี้เนื้อหาเก่า', async () => {
      const jobId = randomUUID();
      const companyId = randomUUID();
      const newer = submitted({ job_id: jobId, company_id: companyId, submitted_at: new Date(Date.now() + 1000).toISOString() }, { description: LONG + PHONE });
      const older = submitted({ job_id: jobId, company_id: companyId, submitted_at: new Date(Date.now() - 1000).toISOString() }, { description: LONG + PHONE });
      await submit(newer);
      await submit(older);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0].submissionId).to.equal(newer.submission_id);
      expect(await t.prisma.outboxEvent.count()).to.equal(1);
    });
  });

  describe('E03 ไม่มี submission_id ต้องไม่เดาจากผลตรวจล่าสุด (ผลรีวิว #3)', () => {
    it('มีผลตรวจเก่าอยู่แต่ E03 ไม่ระบุ submission → รายการไม่ผูกกับผลเก่า (submission_id/risk_level ว่าง, priority NORMAL)', async () => {
      const p = submitted({ fast_track: true });
      await submit(p); // APPROVE
      await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id })); // ไม่มี submission_id
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ submissionId: null, riskLevel: null, priority: 'NORMAL', origin: 'VERIFY_TIMEOUT' });
    });
  });

  describe('ผลตรวจที่มาหลัง VERIFY_TIMEOUT (แนบกับรายการ ไม่ส่ง JobVerified)', () => {
    const cases: Array<[string, Partial<ReturnType<typeof submitted>['content']>, string]> = [
      ['APPROVE', {}, 'LOW'],
      ['AUTO_REJECT', { description: LONG + ' ต้องจ่ายค่ามัดจำ' }, 'HIGH'],
      ['PENDING_REVIEW', { description: LONG + PHONE }, 'MEDIUM'],
    ];
    for (const [decision, content, level] of cases) {
      it(`${decision}: บันทึก evaluations, เติม risk_level=${level} ให้รายการเดิม, ไม่ส่ง JobVerified, ยังรายการเดียว`, async () => {
        const p = submitted({ submitted_at: ago(6 * 60_000) }, content);
        await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id, submission_id: p.submission_id }));
        await submit(p);

        expect(await t.prisma.evaluation.count()).to.equal(1);
        expect(await t.prisma.outboxEvent.count()).to.equal(0);
        const all = await items();
        expect(all).to.have.length(1);
        expect(all[0]).to.include({ riskLevel: level, submissionId: p.submission_id, origin: 'VERIFY_TIMEOUT', status: 'OPEN' });
      });
    }

    it('E03 ไม่มี submission_id และยังไม่มีผลตรวจ: E01 ที่ส่งก่อนหมดเวลา → แนบและเติม submission_id', async () => {
      const p = submitted({ submitted_at: ago(6 * 60_000) });
      await timeout(statusChanged({ job_id: p.job_id, company_id: p.company_id }));
      expect((await items())[0].submissionId).to.equal(null);
      await submit(p);
      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0].submissionId).to.equal(p.submission_id);
      expect(await t.prisma.outboxEvent.count()).to.equal(0);
    });

    it('E01 คนละ submission (ส่งใหม่หลังหมดเวลา) → ไม่ใช่ผลที่มาทีหลัง: รายการ timeout ถูก SUPERSEDED และผลใหม่ส่ง JobVerified ตามปกติ', async () => {
      const old = submitted({ submitted_at: ago(6 * 60_000) });
      await timeout(statusChanged({ job_id: old.job_id, company_id: old.company_id, submission_id: old.submission_id }));
      const fresh = submitted({ job_id: old.job_id, company_id: old.company_id, submission_kind: 'EDIT' });
      await submit(fresh);

      const all = await items();
      expect(all).to.have.length(1);
      expect(all[0]).to.include({ status: 'RESOLVED', resolution: 'SUPERSEDED', origin: 'VERIFY_TIMEOUT' });
      const out = await outbox();
      expect(out).to.have.length(1);
      expect((out[0].payload as any).submission_id).to.equal(fresh.submission_id);
    });

    it('E01 ที่ submission_id ไม่ตรงกับรายการ timeout (E03 ระบุ submission อื่น) และส่งก่อนหมดเวลา → supersede + ส่งผลปกติ', async () => {
      const a = submitted({ submitted_at: ago(6 * 60_000) });
      await timeout(statusChanged({ job_id: a.job_id, company_id: a.company_id, submission_id: randomUUID() }));
      await submit(a);
      expect((await items())[0]).to.include({ status: 'RESOLVED', resolution: 'SUPERSEDED' });
      expect(await t.prisma.outboxEvent.count()).to.equal(1);
    });
  });
});
