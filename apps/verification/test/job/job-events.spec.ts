import { randomUUID } from 'node:crypto';
import type { JobStatusChangedPayload } from '@internpath/contracts';
import { expect } from 'chai';
import { JobEventsService } from '../../src/job/job-events.service';
import { JobModule } from '../../src/job/job.module';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { envelope, statusChanged } from '../support/events';

describe('JobEventsService: E03 → job_snapshots + นับการปฏิเสธ (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: JobEventsService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [JobModule], db });
    svc = t.app.get(JobEventsService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe(
      'TRUNCATE job_snapshots, company_rejection_events, company_flags, queue_items, outbox_events, status_history, evaluations',
    );
  });

  const send = (over: Partial<JobStatusChangedPayload>, eventId?: string) => {
    const env = envelope('JobStatusChanged', statusChanged({ reason_code: undefined, ...over }));
    if (eventId) env.event_id = eventId;
    return t.prisma.$transaction((tx) => svc.handleJobStatusChanged(env, tx));
  };
  const snap = (jobId: string) => t.prisma.jobSnapshot.findUnique({ where: { jobId } });
  const rejections = (companyId: string) => t.prisma.companyRejectionEvent.findMany({ where: { companyId }, orderBy: { occurredAt: 'asc' } });

  it('to=PUBLISHED ⇒ สร้าง job_snapshots {status, company_id} และไม่มีเหตุการณ์ปฏิเสธ', async () => {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await send({ job_id: jobId, company_id: companyId, from_status: 'VERIFYING', to_status: 'PUBLISHED', entity_version: 2 });
    expect(await snap(jobId)).to.include({ companyId, status: 'PUBLISHED', entityVersion: 2 });
    expect(await rejections(companyId)).to.have.length(0);
  });

  it('entity_version เก่ากว่ามาทีหลัง ⇒ snapshot ไม่ถอย แต่ to=REMOVED ของ version เก่ายังนับเป็นเหตุการณ์ปฏิเสธ', async () => {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await send({ job_id: jobId, company_id: companyId, from_status: 'SUSPENDED', to_status: 'PUBLISHED', entity_version: 5 });
    await send({ job_id: jobId, company_id: companyId, from_status: 'SUSPENDED', to_status: 'REMOVED', entity_version: 3 });
    expect(await snap(jobId)).to.include({ status: 'PUBLISHED', entityVersion: 5 });
    const r = await rejections(companyId);
    expect(r).to.have.length(1);
    expect(r[0]).to.include({ kind: 'REMOVED', jobId });
  });

  it('E03 ตัวเดียวกัน (event_id เดิม) ประมวลผลสองครั้ง ⇒ เหตุการณ์ปฏิเสธแถวเดียว', async () => {
    const companyId = randomUUID();
    const eventId = randomUUID();
    const over = { company_id: companyId, from_status: 'VERIFYING', to_status: 'AUTO_REJECTED' };
    await send({ ...over, job_id: randomUUID() }, eventId);
    await send({ ...over, job_id: randomUUID() }, eventId);
    expect(await rejections(companyId)).to.have.length(1);
  });

  it('ประกาศที่ไม่เคยรู้จักและ to=SUSPENDED ⇒ สร้าง snapshot + นับปฏิเสธ ไม่ล้ม', async () => {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await send({ job_id: jobId, company_id: companyId, from_status: 'PUBLISHED', to_status: 'SUSPENDED', entity_version: 4 });
    expect(await snap(jobId)).to.include({ status: 'SUSPENDED' });
    expect((await rejections(companyId))[0]).to.include({ kind: 'SUSPENDED' });
  });

  it('AUTO_REJECTED + ADMIN_REJECTED + SUSPENDED ต่างประกาศของบริษัทเดียว ⇒ ติดธง + COMPANY_ACCOUNT + E18', async () => {
    const companyId = randomUUID();
    await send({ company_id: companyId, from_status: 'VERIFYING', to_status: 'AUTO_REJECTED' });
    await send({ company_id: companyId, from_status: 'PENDING_REVIEW', to_status: 'ADMIN_REJECTED' });
    expect((await t.prisma.companyFlag.findUnique({ where: { companyId } }))?.underReview ?? false).to.equal(false);
    await send({ company_id: companyId, from_status: 'PUBLISHED', to_status: 'SUSPENDED' });
    expect(await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId } })).to.include({ underReview: true, triggerCount: 3 });
    expect(await t.prisma.queueItem.count({ where: { targetId: companyId, type: 'COMPANY_ACCOUNT', status: 'OPEN' } })).to.equal(1);
    const e18 = await t.prisma.outboxEvent.findMany({ where: { type: 'CompanyFlagChanged' } });
    expect(e18).to.have.length(1);
    expect(e18[0].payload).to.include({ company_id: companyId, active: true });
  });

  it('ประกาศเดียว SUSPENDED แล้ว REMOVED ⇒ นับ 2 ครั้ง (README "รวมกัน ครบ 3 ครั้ง")', async () => {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await send({ job_id: jobId, company_id: companyId, from_status: 'PUBLISHED', to_status: 'SUSPENDED', entity_version: 2 });
    await send({ job_id: jobId, company_id: companyId, from_status: 'SUSPENDED', to_status: 'REMOVED', entity_version: 3 });
    expect(await rejections(companyId)).to.have.length(2);
  });

  it('E03 v1 กับ v2 ของ 40 ประกาศประมวลผลขนานกัน ⇒ ทุกประกาศจบที่ v2 (snapshot ไม่ถูก v1 ทับ/ทำให้ v2 ถูกข้าม)', async () => {
    const ids = Array.from({ length: 40 }, () => randomUUID());
    await Promise.all(
      ids.flatMap((jobId) => [
        send({ job_id: jobId, from_status: 'VERIFYING', to_status: 'PUBLISHED', entity_version: 1 }),
        send({ job_id: jobId, from_status: 'PUBLISHED', to_status: 'CLOSED', entity_version: 2 }),
      ]),
    );
    const rows = await t.prisma.jobSnapshot.findMany({ where: { jobId: { in: ids } } });
    expect(rows).to.have.length(40);
    expect(rows.filter((r) => r.entityVersion !== 2 || r.status !== 'CLOSED')).to.have.length(0);
  });

  it('VERIFY_TIMEOUT ยังสร้าง JOB_REVIEW เหมือนเดิม และ to=PENDING_REVIEW ปกติไม่นับเป็นปฏิเสธ', async () => {
    const jobId = randomUUID();
    const companyId = randomUUID();
    await send({ job_id: jobId, company_id: companyId, from_status: 'VERIFYING', to_status: 'PENDING_REVIEW', reason_code: 'VERIFY_TIMEOUT', submission_id: randomUUID() });
    expect(await t.prisma.queueItem.count({ where: { targetId: jobId, type: 'JOB_REVIEW', origin: 'VERIFY_TIMEOUT' } })).to.equal(1);
    expect(await rejections(companyId)).to.have.length(0);
    expect(await snap(jobId)).to.include({ status: 'PENDING_REVIEW' });
  });
});
