import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { EvaluationModule } from '../../src/evaluation/evaluation.module';
import { EvaluationService } from '../../src/evaluation/evaluation.service';
import { QueueModule } from '../../src/queue/queue.module';
import { QueueService } from '../../src/queue/queue.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { LONG, PHONE, envelope, statusChanged, submitted, submittedEnv } from '../support/events';

describe('Admin queue API (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let evaluation: EvaluationService;
  let queue: QueueService;
  let adminId: string;
  let admin: { Authorization: string };

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [QueueModule, EvaluationModule], db });
    evaluation = t.app.get(EvaluationService);
    queue = t.app.get(QueueService);
    adminId = randomUUID();
    admin = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN', sub: adminId })}` };
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE evaluations, queue_items, outbox_events, appeals, company_snapshots, admin_audit_log, status_history');
  });

  const http = () => request(t.app.getHttpServer());
  const submit = (p: ReturnType<typeof submitted>) => t.prisma.$transaction((tx) => evaluation.handleJobSubmitted(submittedEnv(p), tx));
  const itemFor = (jobId: string) => t.prisma.queueItem.findFirstOrThrow({ where: { targetId: jobId } });
  const verifiedOut = async () =>
    (await t.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } })).filter((o) => o.type === 'JobVerified').map((o) => o.payload as any);

  async function pendingJob(content: Parameters<typeof submitted>[1] = { description: LONG + PHONE }, over: Parameters<typeof submitted>[0] = {}) {
    const p = submitted(over, content);
    await submit(p);
    return { p, item: await itemFor(p.job_id) };
  }

  it('สิทธิ์: ไม่มี token 401; HR/นักศึกษา 403 ทุก endpoint', async () => {
    const hr = { Authorization: `Bearer ${t.token({ role: 'COMPANY_HR', company_id: randomUUID() })}` };
    const student = { Authorization: `Bearer ${t.token({ role: 'STUDENT' })}` };
    const id = randomUUID();
    const calls: Array<[string, string]> = [
      ['get', '/v1/admin/queue'],
      ['get', `/v1/admin/queue/${id}`],
      ['post', `/v1/admin/queue/${id}/actions/approve`],
      ['post', `/v1/admin/queue/${id}/actions/reject`],
    ];
    for (const [m, url] of calls) {
      await (http() as any)[m](url).expect(401);
      await (http() as any)[m](url).set(hr).expect(403);
      await (http() as any)[m](url).set(student).expect(403);
    }
  });

  describe('GET /admin/queue', () => {
    it('ตัวกรองทั้ง 5 ตัว, เรียง FAST_TRACK ก่อนแล้ว due_at น้อยไปมาก, Pagination, company_name จาก snapshot', async () => {
      const companyId = randomUUID();
      await t.prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท ทดสอบ จำกัด', status: 'VERIFIED', entityVersion: 1 } });
      const mk = (over: Partial<Parameters<QueueService['createItem']>[1]>) =>
        t.prisma.$transaction((tx) =>
          queue.createItem(tx, {
            type: 'JOB_REVIEW', jobId: randomUUID(), companyId, submissionId: randomUUID(), riskLevel: 'MEDIUM',
            fastTrack: false, origin: 'EVALUATION', ...over,
          }),
        );
      const now = Date.now();
      const a = await mk({ now: new Date(now) });
      const b = await mk({ fastTrack: true, riskLevel: 'HIGH', now: new Date(now) });
      const c = await mk({ riskLevel: 'LOW', now: new Date(now - 3 * 24 * 3600_000) }); // เลยกำหนด
      const d = await mk({ type: 'JOB_APPEAL', origin: 'APPEAL', now: new Date(now + 1000) });
      await t.prisma.queueItem.update({ where: { id: d.id }, data: { status: 'RESOLVED', resolvedAt: new Date() } });

      const list = (qs = '') => http().get(`/v1/admin/queue${qs}`).set(admin).expect(200).then((r) => r.body);
      const all = await list();
      expect(all.meta).to.deep.equal({ page: 1, page_size: 20, total: 4 });
      expect(all.data.map((x: any) => x.id)).to.deep.equal([b.id, c.id, a.id, d.id].sort((x, y) => order(x) - order(y)));
      function order(id: string) {
        return [b.id, c.id, a.id, d.id].indexOf(id);
      }
      expect(all.data[0]).to.include({ priority: 'FAST_TRACK', company_name: 'บริษัท ทดสอบ จำกัด', type: 'JOB_REVIEW' });
      expect(all.data[0]).to.have.all.keys('id', 'type', 'target_id', 'company_id', 'company_name', 'priority', 'risk_level', 'is_appeal', 'due_at', 'overdue', 'status', 'created_at');

      expect((await list('?type=JOB_APPEAL')).data.map((x: any) => x.id)).to.deep.equal([d.id]);
      expect((await list('?priority=FAST_TRACK')).data.map((x: any) => x.id)).to.deep.equal([b.id]);
      expect((await list('?risk_level=LOW')).data.map((x: any) => x.id)).to.deep.equal([c.id]);
      expect((await list('?status=RESOLVED')).data.map((x: any) => x.id)).to.deep.equal([d.id]);
      const overdue = await list('?overdue=true');
      expect(overdue.data.map((x: any) => x.id)).to.deep.equal([c.id]);
      expect(overdue.data[0].overdue).to.equal(true);
      expect(all.data.find((x: any) => x.id === a.id).overdue).to.equal(false);

      const p2 = await list('?page=2&page_size=3');
      expect(p2.meta).to.deep.equal({ page: 2, page_size: 3, total: 4 });
      expect(p2.data).to.have.length(1);
    });

    it('ตัวกรองที่ไม่ถูกต้อง → 400', async () => {
      await http().get('/v1/admin/queue?type=NOPE').set(admin).expect(400);
      await http().get('/v1/admin/queue?priority=URGENT').set(admin).expect(400);
      await http().get('/v1/admin/queue?page_size=101').set(admin).expect(400);
    });
  });

  describe('GET /admin/queue/:id', () => {
    it('รายละเอียด + reasons + content + highlights (คำที่ปฏิเสธมี negated=true) + company_name', async () => {
      const companyId = randomUUID();
      await t.prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท ตัวอย่าง', status: 'VERIFIED', entityVersion: 1 } });
      const { p, item } = await pendingJob({ description: LONG + ' ไม่มีค่ามัดจำ' }, { company_id: companyId });

      const res = await http().get(`/v1/admin/queue/${item.id}`).set(admin).expect(200);
      expect(res.body).to.include({ id: item.id, type: 'JOB_REVIEW', company_name: 'บริษัท ตัวอย่าง', submission_id: p.submission_id, status: 'OPEN', origin: 'EVALUATION' });
      expect(res.body.reasons.map((r: any) => r.code)).to.include('BLACKLIST_NEGATED');
      expect(res.body.highlights).to.have.length(1);
      expect(res.body.highlights[0]).to.include({ field: 'description', keyword: 'ค่ามัดจำ', negated: true });
      const h = res.body.highlights[0];
      expect(res.body.content.description.slice(h.start, h.end)).to.equal('ค่ามัดจำ');
    });

    it('ข้อความที่มีอักขระความกว้างศูนย์: ไฮไลต์ตรงกับ content ที่ API คืน', async () => {
      const { item } = await pendingJob({ description: LONG + ' ไม่มี ค่า​มัดจำ' });
      const res = await http().get(`/v1/admin/queue/${item.id}`).set(admin).expect(200);
      expect(res.body.content.description).to.not.include('​');
      const h = res.body.highlights[0];
      expect(res.body.content.description.slice(h.start, h.end).toLowerCase()).to.equal('ค่ามัดจำ');
    });

    it('รายการ timeout ที่ยังไม่มีผลตรวจ: reasons/highlights ว่าง, content เป็น null', async () => {
      const s = statusChanged({ submission_id: randomUUID() });
      await t.prisma.$transaction((tx) => evaluation.handleJobStatusChanged(envelope('JobStatusChanged', s), tx));
      const item = await itemFor(s.job_id);
      const res = await http().get(`/v1/admin/queue/${item.id}`).set(admin).expect(200);
      expect(res.body).to.include({ origin: 'VERIFY_TIMEOUT', risk_level: null });
      expect(res.body.reasons).to.deep.equal([]);
      expect(res.body.highlights).to.deep.equal([]);
      expect(res.body.content).to.equal(null);
    });

    it('id ที่ไม่มี → 404; ไม่ใช่ UUID → 400', async () => {
      await http().get(`/v1/admin/queue/${randomUUID()}`).set(admin).expect(404);
      await http().get('/v1/admin/queue/not-a-uuid').set(admin).expect(400);
    });
  });

  describe('actions', () => {
    it('approve → 204, RESOLVED(ADMIN_APPROVE), JobVerified ADMIN_APPROVE โดย ADMIN พร้อมผลตรวจเดิม, status_history และ audit อย่างละแถวต่อ action', async () => {
      const { p, item } = await pendingJob();
      await http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin).expect(204);

      const after = await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } });
      expect(after).to.include({ status: 'RESOLVED', resolution: 'ADMIN_APPROVE' });
      expect(after.resolvedAt).to.be.instanceOf(Date);

      const out = await verifiedOut();
      expect(out).to.have.length(2);
      expect(out[1]).to.deep.include({ job_id: p.job_id, submission_id: p.submission_id, decision: 'ADMIN_APPROVE', is_appeal: false, decided_by: 'ADMIN', risk_level: 'MEDIUM' });
      expect(out[1].reasons.map((r: any) => r.code)).to.include('CONTACT_IN_TEXT');

      const hist = await t.prisma.statusHistory.findMany({ where: { entityId: item.id }, orderBy: { occurredAt: 'asc' } });
      expect(hist).to.have.length(2);
      expect(hist[1]).to.include({ fromStatus: 'OPEN', toStatus: 'RESOLVED', actorId: adminId, actorRole: 'PLATFORM_ADMIN' });
      const audits = await t.prisma.adminAuditLog.findMany({ where: { action: 'QUEUE_APPROVE' } });
      expect(audits).to.have.length(1);
      expect(audits[0]).to.include({ adminId, targetType: 'queue_item', targetId: item.id });
    });

    it('reject ไม่มี reason → 400; มี reason → ADMIN_REJECT มี ADMIN_REASON, resolution ADMIN_REJECT, เหตุผลเก็บใน status_history และ audit', async () => {
      const { item } = await pendingJob();
      const bad = await http().post(`/v1/admin/queue/${item.id}/actions/reject`).set(admin).send({}).expect(400);
      expect(bad.body.error.code).to.equal('VALIDATION_FAILED');
      await http().post(`/v1/admin/queue/${item.id}/actions/reject`).set(admin).send({ reason: '  ' }).expect(400);
      expect((await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).status).to.equal('OPEN');

      await http().post(`/v1/admin/queue/${item.id}/actions/reject`).set(admin).send({ reason: 'มีช่องทางติดต่อส่วนตัว' }).expect(204);
      expect((await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).resolution).to.equal('ADMIN_REJECT');
      const last = (await verifiedOut()).pop();
      expect(last).to.deep.include({ decision: 'ADMIN_REJECT', decided_by: 'ADMIN' });
      expect(last.reasons.find((r: any) => r.code === 'ADMIN_REASON').detail).to.equal('มีช่องทางติดต่อส่วนตัว');
      const hist = await t.prisma.statusHistory.findFirstOrThrow({ where: { entityId: item.id, toStatus: 'RESOLVED' } });
      expect(hist.reason).to.equal('มีช่องทางติดต่อส่วนตัว');
      expect((await t.prisma.adminAuditLog.findFirstOrThrow({ where: { action: 'QUEUE_REJECT' } })).reason).to.equal('มีช่องทางติดต่อส่วนตัว');
    });

    it('ทำซ้ำบนรายการ RESOLVED → 409 STATE_CONFLICT และไม่มี Event เพิ่ม', async () => {
      const { item } = await pendingJob();
      await http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin).expect(204);
      const r = await http().post(`/v1/admin/queue/${item.id}/actions/reject`).set(admin).send({ reason: 'x' }).expect(409);
      expect(r.body.error.code).to.equal('STATE_CONFLICT');
      await http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin).expect(409);
      expect(await verifiedOut()).to.have.length(2);
    });

    it('Admin สองคนกด approve พร้อมกัน → หนึ่ง 204 หนึ่ง 409 และ JobVerified ของ Admin เพียง 1 แถว', async () => {
      const { item } = await pendingJob();
      const other = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN' })}` };
      const results = await Promise.all([
        http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin),
        http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(other),
      ]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([204, 409]);
      expect((await verifiedOut()).filter((o) => o.decided_by === 'ADMIN')).to.have.length(1);
      expect(await t.prisma.adminAuditLog.count({ where: { action: 'QUEUE_APPROVE' } })).to.equal(1);
    });

    it('รายการที่ submission_id ว่าง (timeout ไม่มีผลตรวจ) → 422 SUBMISSION_UNKNOWN รายการยังเปิดและไม่มี Event', async () => {
      const s = statusChanged();
      await t.prisma.$transaction((tx) => evaluation.handleJobStatusChanged(envelope('JobStatusChanged', s), tx));
      const item = await itemFor(s.job_id);
      const r = await http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin).expect(422);
      expect(r.body.error.code).to.equal('SUBMISSION_UNKNOWN');
      expect((await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).status).to.equal('OPEN');
      expect(await t.prisma.outboxEvent.count()).to.equal(0);
      expect(await t.prisma.adminAuditLog.count()).to.equal(0);
    });

    it('JOB_APPEAL: approve → appeals APPROVED + ADMIN_APPROVE is_appeal=true; reject → DENIED + ADMIN_REJECT', async () => {
      for (const action of ['approve', 'reject'] as const) {
        const jobId = randomUUID();
        const submissionId = randomUUID();
        await t.prisma.appeal.create({ data: { jobId, submissionId, statement: 'ขออุทธรณ์เพราะข้อความถูกตีความผิดพลาด' } });
        const item = await t.prisma.$transaction((tx) =>
          queue.createItem(tx, { type: 'JOB_APPEAL', jobId, companyId: randomUUID(), submissionId, riskLevel: 'HIGH', fastTrack: false, origin: 'APPEAL' }),
        );
        expect(item.isAppeal).to.equal(true);
        await http().post(`/v1/admin/queue/${item.id}/actions/${action}`).set(admin).send(action === 'reject' ? { reason: 'ไม่ผ่าน' } : {}).expect(204);
        const appeal = await t.prisma.appeal.findUniqueOrThrow({ where: { jobId } });
        expect(appeal).to.include({ status: action === 'approve' ? 'APPROVED' : 'DENIED', decidedBy: adminId });
        expect(appeal.decidedAt).to.be.instanceOf(Date);
        const last = (await verifiedOut()).pop();
        expect(last).to.deep.include({ job_id: jobId, is_appeal: true, decision: action === 'approve' ? 'ADMIN_APPROVE' : 'ADMIN_REJECT' });
      }
    });

    it('รายการชนิดที่สไลซ์นี้ยังไม่รองรับ → 422 UNSUPPORTED_ITEM_TYPE; id ที่ไม่มี → 404', async () => {
      const item = await t.prisma.queueItem.create({
        data: { type: 'REVIEW_HELD', targetType: 'review', targetId: randomUUID(), origin: 'EVALUATION', dueAt: new Date(Date.now() + 1000), submissionId: randomUUID() },
      });
      const r = await http().post(`/v1/admin/queue/${item.id}/actions/approve`).set(admin).expect(422);
      expect(r.body.error.code).to.equal('UNSUPPORTED_ITEM_TYPE');
      await http().post(`/v1/admin/queue/${randomUUID()}/actions/approve`).set(admin).expect(404);
    });
  });
});
