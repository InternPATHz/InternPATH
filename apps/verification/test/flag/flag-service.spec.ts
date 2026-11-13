import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { FlagModule } from '../../src/flag/flag.module';
import { FlagService } from '../../src/flag/flag.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const DAY = 86_400_000;
type Kind = 'AUTO_REJECTED' | 'ADMIN_REJECTED' | 'SUSPENDED' | 'REMOVED';

describe('FlagService: ธง UNDER_REVIEW (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let flag: FlagService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [FlagModule], db });
    flag = t.app.get(FlagService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE company_flags, company_rejection_events, queue_items, outbox_events, status_history');
  });

  const reject = (companyId: string, at: Date, o: { kind?: Kind; eventId?: string } = {}) =>
    t.prisma.$transaction((tx) =>
      flag.recordRejection(tx, {
        companyId,
        jobId: randomUUID(),
        kind: o.kind ?? 'AUTO_REJECTED',
        occurredAt: at,
        sourceEventId: o.eventId ?? randomUUID(),
        correlationId: randomUUID(),
      }),
    );
  const flagEvents = async () =>
    (await t.prisma.outboxEvent.findMany({ where: { type: 'CompanyFlagChanged' }, orderBy: { createdAt: 'asc' } })).map((o) => o.payload as any);
  const companyItems = (companyId: string) => t.prisma.queueItem.findMany({ where: { targetId: companyId, type: 'COMPANY_ACCOUNT' } });
  const T = () => new Date();

  it('3 เหตุการณ์ใน 30 วัน (เก่าสุด 29 วัน) ⇒ ติดธง + COMPANY_ACCOUNT 1 รายการ + E18 active=true trigger_count=3', async () => {
    const c = randomUUID();
    const now = T();
    await reject(c, new Date(now.getTime() - 29 * DAY), { kind: 'AUTO_REJECTED' });
    await reject(c, new Date(now.getTime() - 15 * DAY), { kind: 'ADMIN_REJECTED' });
    expect(await flagEvents()).to.have.length(0);
    await reject(c, now, { kind: 'SUSPENDED' });

    const row = await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } });
    expect(row).to.include({ underReview: true, setBy: 'SYSTEM', triggerCount: 3, entityVersion: 1 });
    const items = await companyItems(c);
    expect(items).to.have.length(1);
    expect(items[0]).to.include({ origin: 'REJECTION_THRESHOLD', status: 'OPEN', priority: 'NORMAL', companyId: c });
    const ev = await flagEvents();
    expect(ev).to.have.length(1);
    expect(ev[0]).to.include({ company_id: c, flag: 'UNDER_REVIEW', active: true, trigger_count: 3, set_by: 'SYSTEM', entity_version: 1 });
  });

  it('เหตุการณ์เก่าสุดห่าง 31 วัน ⇒ ไม่นับ ไม่ติดธง', async () => {
    const c = randomUUID();
    const now = T();
    await reject(c, new Date(now.getTime() - 31 * DAY));
    await reject(c, new Date(now.getTime() - 15 * DAY));
    await reject(c, now);
    expect(await t.prisma.companyFlag.findUnique({ where: { companyId: c } }).then((r) => r?.underReview ?? false)).to.equal(false);
    expect(await flagEvents()).to.have.length(0);
    expect(await companyItems(c)).to.have.length(0);
  });

  it('เหตุการณ์ที่ 4 ขณะธงเปิด ⇒ ไม่มีรายการ/E18 เพิ่ม; sourceEventId ซ้ำ ⇒ ไม่นับเพิ่ม', async () => {
    const c = randomUUID();
    const now = T();
    const dup = randomUUID();
    await reject(c, now, { eventId: dup });
    await reject(c, now, { eventId: dup }); // ซ้ำ
    expect(await t.prisma.companyRejectionEvent.count({ where: { companyId: c } })).to.equal(1);
    await reject(c, now);
    await reject(c, now); // ครบ 3 (นับ dup ครั้งเดียว)
    await reject(c, now); // ครั้งที่ 4
    expect(await flagEvents()).to.have.length(1);
    expect(await companyItems(c)).to.have.length(1);
  });

  it('setFlag(active=false): เคลียร์ธง, ตั้ง clearedAt, ปิด COMPANY_ACCOUNT ด้วย ADMIN_CLEAR_FLAG, E18 active=false version 2', async () => {
    const c = randomUUID();
    const admin = randomUUID();
    const now = T();
    for (let i = 0; i < 3; i++) await reject(c, now);
    const r = await t.prisma.$transaction((tx) => flag.setFlag(tx, { companyId: c, active: false, setBy: 'ADMIN', adminId: admin, reason: 'ตรวจแล้วปกติ', correlationId: randomUUID() }));
    expect(r).to.deep.equal({ changed: true });
    const row = await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } });
    expect(row.underReview).to.equal(false);
    expect(row.clearedAt).to.be.instanceOf(Date);
    expect(row.clearedBy).to.equal(admin);
    expect(row.entityVersion).to.equal(2);
    const [item] = await companyItems(c);
    expect(item).to.include({ status: 'RESOLVED', resolution: 'ADMIN_CLEAR_FLAG' });
    const ev = await flagEvents();
    expect(ev[1]).to.include({ active: false, set_by: 'ADMIN', entity_version: 2 });
  });

  it('เคลียร์แล้วเหตุการณ์ก่อน clearedAt ไม่ถูกนับ: 1 ใหม่ไม่ติด, ครบ 3 หลัง clearedAt ติดใหม่', async () => {
    const c = randomUUID();
    const base = T();
    await reject(c, new Date(base.getTime() - 3 * DAY));
    await reject(c, new Date(base.getTime() - 2 * DAY));
    await reject(c, new Date(base.getTime() - 1 * DAY));
    await t.prisma.$transaction((tx) => flag.setFlag(tx, { companyId: c, active: false, setBy: 'ADMIN', adminId: randomUUID(), reason: 'ok', correlationId: randomUUID() }));
    const cleared = (await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } })).clearedAt!;

    await reject(c, new Date(cleared.getTime() + 3600_000));
    expect((await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } })).underReview, 'เก่า 3 + ใหม่ 1 ต้องไม่ติด').to.equal(false);
    await reject(c, new Date(cleared.getTime() + 2 * 3600_000));
    await reject(c, new Date(cleared.getTime() + 3 * 3600_000));
    const row = await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } });
    expect(row).to.include({ underReview: true, triggerCount: 3, entityVersion: 3 });
    expect(await flagEvents()).to.have.length(3); // ติด, เคลียร์, ติดใหม่
  });

  it('setFlag ค่าเดิมอยู่แล้ว ⇒ changed=false ไม่มี Event; ตั้งด้วยมือไม่สร้างรายการคิว', async () => {
    const c = randomUUID();
    const set = (active: boolean) =>
      t.prisma.$transaction((tx) => flag.setFlag(tx, { companyId: c, active, setBy: 'ADMIN', adminId: randomUUID(), reason: 'r', correlationId: randomUUID() }));
    expect(await set(false)).to.deep.equal({ changed: false }); // ยังไม่เคยมีธง = ปิดอยู่แล้ว
    expect(await set(true)).to.deep.equal({ changed: true });
    expect(await set(true)).to.deep.equal({ changed: false });
    expect(await flagEvents()).to.have.length(1);
    expect(await companyItems(c)).to.have.length(0);
  });
});
