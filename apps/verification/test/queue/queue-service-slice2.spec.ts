import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { QueueModule } from '../../src/queue/queue.module';
import { QueueService } from '../../src/queue/queue.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

describe('QueueService สไลซ์ 2: JOB_REPORT / COMPANY_ACCOUNT (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let queue: QueueService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [QueueModule], db });
    queue = t.app.get(QueueService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE queue_items, status_history');
  });

  const reportArgs = (over: Partial<Parameters<QueueService['createReportItem']>[1]> = {}) => ({
    jobId: randomUUID(),
    companyId: randomUUID(),
    submissionId: randomUUID() as string | null,
    origin: 'REPORT_THRESHOLD' as const,
    ...over,
  });

  it('createReportItem: JOB_REPORT, priority NORMAL, due_at = created_at + 48 ชม., เขียน status_history', async () => {
    const now = new Date('2026-11-14T03:00:00Z');
    const a = reportArgs({ now });
    const item = await t.prisma.$transaction((tx) => queue.createReportItem(tx, a));
    expect(item).to.include({ type: 'JOB_REPORT', targetType: 'job', targetId: a.jobId, priority: 'NORMAL', origin: 'REPORT_THRESHOLD', isAppeal: false, status: 'OPEN' });
    expect(item.dueAt.toISOString()).to.equal('2026-11-16T03:00:00.000Z');
    const hist = await t.prisma.statusHistory.findMany({ where: { entityId: item.id } });
    expect(hist).to.have.length(1);
    expect(hist[0]).to.include({ toStatus: 'OPEN', actorRole: 'SYSTEM', reason: 'REPORT_THRESHOLD' });
  });

  it('createReportItem ซ้อนประกาศเดียวขณะเปิด ⇒ ชน partial unique index; ได้เมื่อรายการเดิม RESOLVED', async () => {
    const a = reportArgs();
    const first = await t.prisma.$transaction((tx) => queue.createReportItem(tx, a));
    let code: string | undefined;
    try {
      await t.prisma.$transaction((tx) => queue.createReportItem(tx, a));
    } catch (e) {
      code = (e as { code?: string }).code;
    }
    expect(code).to.equal('P2002');
    await t.prisma.$transaction((tx) => queue.resolveOpenItem(tx, { item: first, resolution: 'X', actorId: null, actorRole: 'SYSTEM' }));
    await t.prisma.$transaction((tx) => queue.createReportItem(tx, a)); // ไม่ throw
  });

  it('createCompanyItem: COMPANY_ACCOUNT targetType company, target = company_id, NORMAL 48 ชม.', async () => {
    const companyId = randomUUID();
    const now = new Date('2026-11-14T03:00:00Z');
    const item = await t.prisma.$transaction((tx) => queue.createCompanyItem(tx, { companyId, origin: 'REJECTION_THRESHOLD', now }));
    expect(item).to.include({ type: 'COMPANY_ACCOUNT', targetType: 'company', targetId: companyId, companyId, priority: 'NORMAL', origin: 'REJECTION_THRESHOLD' });
    expect(item.dueAt.toISOString()).to.equal('2026-11-16T03:00:00.000Z');
  });

  it('findOpenByType: เจอเฉพาะรายการเปิดของชนิดนั้น', async () => {
    const a = reportArgs();
    await t.prisma.$transaction((tx) => queue.createReportItem(tx, a));
    const found = await t.prisma.$transaction((tx) => queue.findOpenByType(tx, a.jobId, 'JOB_REPORT'));
    expect(found?.targetId).to.equal(a.jobId);
    expect(await t.prisma.$transaction((tx) => queue.findOpenByType(tx, a.jobId, 'JOB_REVIEW'))).to.equal(null);
  });

  it('resolveOpenItem: ปิดครั้งแรกได้ true + status_history; ครั้งที่สองได้ false และไม่เพิ่มประวัติ', async () => {
    const item = await t.prisma.$transaction((tx) => queue.createReportItem(tx, reportArgs()));
    const admin = randomUUID();
    const resolve = () =>
      t.prisma.$transaction((tx) =>
        queue.resolveOpenItem(tx, { item, resolution: 'ADMIN_CLEAR_FLAG', actorId: admin, actorRole: 'PLATFORM_ADMIN', reason: 'ตรวจแล้ว' }),
      );
    expect(await resolve()).to.equal(true);
    expect(await resolve()).to.equal(false);
    const row = await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } });
    expect(row).to.include({ status: 'RESOLVED', resolution: 'ADMIN_CLEAR_FLAG' });
    const hist = await t.prisma.statusHistory.findMany({ where: { entityId: item.id, toStatus: 'RESOLVED' } });
    expect(hist).to.have.length(1);
    expect(hist[0]).to.include({ actorId: admin, actorRole: 'PLATFORM_ADMIN', reason: 'ตรวจแล้ว' });
  });
});
