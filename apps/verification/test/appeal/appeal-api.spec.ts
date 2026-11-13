import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { AppealModule } from '../../src/appeal/appeal.module';
import { EvaluationModule } from '../../src/evaluation/evaluation.module';
import { EvaluationService } from '../../src/evaluation/evaluation.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { LONG, PHONE, envelope, statusChanged, submitted, submittedEnv } from '../support/events';

const STATEMENT = 'ขออุทธรณ์เนื่องจากข้อความถูกตีความผิดพลาด ไม่มีการเรียกเก็บเงินใดๆ ทั้งสิ้น';

describe('HR result + appeal API (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let evaluation: EvaluationService;
  const admin = () => ({ Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN' })}` });
  const hr = (companyId: string) => ({ Authorization: `Bearer ${t.token({ role: 'COMPANY_HR', company_id: companyId })}` });

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [AppealModule, EvaluationModule], db });
    evaluation = t.app.get(EvaluationService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE evaluations, queue_items, outbox_events, appeals, admin_audit_log, status_history');
  });

  const http = () => request(t.app.getHttpServer());
  const submit = (p: ReturnType<typeof submitted>) => t.prisma.$transaction((tx) => evaluation.handleJobSubmitted(submittedEnv(p), tx));
  const rejected = (over: Parameters<typeof submitted>[0] = {}) => submitted(over, { description: LONG + ' ต้องจ่ายค่ามัดจำ' });
  const verified = async () => (await t.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } })).map((o) => o.payload as any);

  describe('GET /verification/jobs/:job_id/result', () => {
    it('HR เจ้าของ: รูปแบบตามสัญญา ไม่มี content/assigned_to/submission_id; Admin เห็นผลเดียวกัน', async () => {
      const p = rejected();
      await submit(p);
      const res = await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(hr(p.company_id)).expect(200);
      expect(res.body).to.have.all.keys('risk_level', 'risk_score', 'reasons', 'matched_keywords', 'is_appeal', 'can_appeal');
      expect(res.body).to.include({ risk_level: 'HIGH', is_appeal: false, can_appeal: true });
      expect(res.body.risk_score).to.be.at.least(70);
      expect(res.body.reasons.map((r: any) => r.code)).to.include('BLACKLIST_HARD');
      expect(res.body.matched_keywords[0]).to.deep.equal({ term: 'ค่ามัดจำ', field: 'description', negated: false });
      const asAdmin = await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(admin()).expect(200);
      expect(asAdmin.body).to.deep.equal(res.body);
    });

    it('HR คนละบริษัท → 403; ไม่มี token → 401; นักศึกษา → 403; ประกาศที่ไม่เคยถูกตรวจ → 404; job_id ไม่ใช่ UUID → 400', async () => {
      const p = rejected();
      await submit(p);
      await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(hr(randomUUID())).expect(403);
      await http().get(`/v1/verification/jobs/${p.job_id}/result`).expect(401);
      await http().get(`/v1/verification/jobs/${p.job_id}/result`).set({ Authorization: `Bearer ${t.token({ role: 'STUDENT' })}` }).expect(403);
      await http().get(`/v1/verification/jobs/${randomUUID()}/result`).set(admin()).expect(404);
      await http().get('/v1/verification/jobs/not-a-uuid/result').set(admin()).expect(400);
    });

    it('ผลล่าสุดเลือกจาก submitted_at ไม่ใช่เวลาบันทึก', async () => {
      const jobId = randomUUID();
      const companyId = randomUUID();
      const newer = rejected({ job_id: jobId, company_id: companyId, submitted_at: new Date(Date.now() + 3600_000).toISOString() });
      const older = submitted({ job_id: jobId, company_id: companyId, submitted_at: new Date(Date.now() - 3600_000).toISOString() });
      await submit(newer); // บันทึกก่อน แต่ submitted_at ใหม่กว่า
      await submit(older); // บันทึกทีหลัง แต่ submitted_at เก่ากว่า (APPROVE)
      const res = await http().get(`/v1/verification/jobs/${jobId}/result`).set(hr(companyId)).expect(200);
      expect(res.body).to.include({ risk_level: 'HIGH', can_appeal: true });
    });
  });

  describe('POST /verification/jobs/:job_id/appeal', () => {
    it('สำเร็จ → 201; appeals(OPEN), คิว JOB_APPEAL, outbox APPEAL_ACCEPTED; result แสดง can_appeal=false และ is_appeal=true', async () => {
      const p = rejected({ fast_track: true });
      await submit(p);
      const res = await http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }).expect(201);
      expect(res.body).to.include({ status: 'OPEN' });

      const appeal = await t.prisma.appeal.findUniqueOrThrow({ where: { jobId: p.job_id } });
      expect(appeal).to.include({ status: 'OPEN', submissionId: p.submission_id, statement: STATEMENT });

      const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: p.job_id } });
      expect(item).to.include({ type: 'JOB_APPEAL', isAppeal: true, origin: 'APPEAL', riskLevel: 'HIGH', submissionId: p.submission_id, priority: 'FAST_TRACK', status: 'OPEN' });

      const out = await verified();
      expect(out).to.have.length(2);
      expect(out[1]).to.deep.include({ job_id: p.job_id, submission_id: p.submission_id, decision: 'APPEAL_ACCEPTED', is_appeal: true, decided_by: 'SYSTEM', risk_level: 'HIGH' });

      const after = await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(hr(p.company_id)).expect(200);
      expect(after.body).to.include({ can_appeal: false, is_appeal: true });
    });

    it('ครั้งที่สอง → 409 APPEAL_ALREADY_USED ไม่เพิ่มแถว; พร้อมกัน 2 ครั้ง → 201 กับ 409 และมี appeals/คิว/outbox อย่างละหนึ่งชุด', async () => {
      const p = rejected();
      await submit(p);
      const results = await Promise.all([
        http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }),
        http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }),
      ]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409]);
      expect(results.find((r) => r.status === 409)!.body.error.code).to.equal('APPEAL_ALREADY_USED');
      expect(await t.prisma.appeal.count()).to.equal(1);
      expect(await t.prisma.queueItem.count()).to.equal(1);
      expect(await t.prisma.outboxEvent.count()).to.equal(2);

      const again = await http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }).expect(409);
      expect(again.body.error.code).to.equal('APPEAL_ALREADY_USED');
      expect(await t.prisma.appeal.count()).to.equal(1);
    });

    it('ผลล่าสุดเป็น APPROVE/PENDING_REVIEW → 409 STATE_CONFLICT; statement สั้นเกิน → 400; HR คนละบริษัท → 403; ไม่มีผล → 404', async () => {
      const ok = submitted();
      await submit(ok);
      const r1 = await http().post(`/v1/verification/jobs/${ok.job_id}/appeal`).set(hr(ok.company_id)).send({ statement: STATEMENT }).expect(409);
      expect(r1.body.error.code).to.equal('STATE_CONFLICT');
      const yellow = submitted({}, { description: LONG + PHONE });
      await submit(yellow);
      await http().post(`/v1/verification/jobs/${yellow.job_id}/appeal`).set(hr(yellow.company_id)).send({ statement: STATEMENT }).expect(409);

      const bad = rejected();
      await submit(bad);
      const short = await http().post(`/v1/verification/jobs/${bad.job_id}/appeal`).set(hr(bad.company_id)).send({ statement: 'สั้น' }).expect(400);
      expect(short.body.error.code).to.equal('VALIDATION_FAILED');
      await http().post(`/v1/verification/jobs/${bad.job_id}/appeal`).set(hr(randomUUID())).send({ statement: STATEMENT }).expect(403);
      await http().post(`/v1/verification/jobs/${randomUUID()}/appeal`).set(hr(bad.company_id)).send({ statement: STATEMENT }).expect(404);
      expect(await t.prisma.appeal.count()).to.equal(0);
    });

    it('สิทธิ์: ไม่มี token → 401; Admin/นักศึกษา → 403 (อุทธรณ์ได้เฉพาะ HR เจ้าของ)', async () => {
      const p = rejected();
      await submit(p);
      const url = `/v1/verification/jobs/${p.job_id}/appeal`;
      await http().post(url).send({ statement: STATEMENT }).expect(401);
      await http().post(url).set(admin()).send({ statement: STATEMENT }).expect(403);
      await http().post(url).set({ Authorization: `Bearer ${t.token({ role: 'STUDENT' })}` }).send({ statement: STATEMENT }).expect(403);
    });

    it('มีรายการคิวเปิดอยู่ (VERIFY_TIMEOUT + ผลตรวจที่มาทีหลังเป็น AUTO_REJECT): can_appeal=false และอุทธรณ์ → 409 ไม่ใช้สิทธิ์ ไม่เกิดรายการซ้อน (ผลรีวิว #2)', async () => {
      const p = rejected();
      await t.prisma.$transaction((tx) =>
        evaluation.handleJobStatusChanged(
          envelope('JobStatusChanged', statusChanged({ job_id: p.job_id, company_id: p.company_id, submission_id: p.submission_id })),
          tx,
        ),
      );
      await submit(p); // แนบกับรายการ timeout เดิม ไม่ส่ง JobVerified
      expect(await t.prisma.queueItem.count()).to.equal(1);

      const res = await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(hr(p.company_id)).expect(200);
      expect(res.body).to.include({ risk_level: 'HIGH', can_appeal: false });
      const r = await http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }).expect(409);
      expect(r.body.error.code).to.equal('STATE_CONFLICT');
      expect(await t.prisma.appeal.count()).to.equal(0);
      expect(await t.prisma.queueItem.count()).to.equal(1);
      expect(await t.prisma.outboxEvent.count()).to.equal(0);
    });

    it('Admin ปฏิเสธอุทธรณ์ → result มี admin_reason; ส่งใหม่แล้วถูก AUTO_REJECT อีก → can_appeal=false และอุทธรณ์ → 409 APPEAL_ALREADY_USED', async () => {
      const p = rejected();
      await submit(p);
      await http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }).expect(201);
      const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: p.job_id } });
      await http().post(`/v1/admin/queue/${item.id}/actions/reject`).set(admin()).send({ reason: 'ข้อความยังมีการเรียกเก็บเงิน' }).expect(204);

      const denied = await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(hr(p.company_id)).expect(200);
      expect(denied.body.admin_reason).to.equal('ข้อความยังมีการเรียกเก็บเงิน');
      expect(denied.body).to.not.have.property('content');

      const again = rejected({ job_id: p.job_id, company_id: p.company_id, submission_kind: 'RESUBMIT', submitted_at: new Date(Date.now() + 5000).toISOString() });
      await submit(again);
      const res = await http().get(`/v1/verification/jobs/${p.job_id}/result`).set(hr(p.company_id)).expect(200);
      expect(res.body).to.include({ can_appeal: false, risk_level: 'HIGH' });
      expect(res.body).to.not.have.property('admin_reason');
      const r = await http().post(`/v1/verification/jobs/${p.job_id}/appeal`).set(hr(p.company_id)).send({ statement: STATEMENT }).expect(409);
      expect(r.body.error.code).to.equal('APPEAL_ALREADY_USED');
    });
  });
});
