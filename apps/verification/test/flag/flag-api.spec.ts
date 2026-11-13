import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { FlagModule } from '../../src/flag/flag.module';
import { FlagService } from '../../src/flag/flag.service';
import { QueueModule } from '../../src/queue/queue.module';
import { QueueService } from '../../src/queue/queue.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

describe('ธงบริษัท UNDER_REVIEW: API ของ Admin (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let flags: FlagService;
  let queue: QueueService;
  let adminId: string;
  let admin: { Authorization: string };

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [FlagModule, QueueModule], db });
    flags = t.app.get(FlagService);
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
      'TRUNCATE company_flags, company_rejection_events, company_snapshots, queue_items, outbox_events, status_history, admin_audit_log',
    );
  });

  const http = () => request(t.app.getHttpServer());
  const put = (companyId: string, body: object) => http().put(`/v1/admin/flags/companies/${companyId}/under-review`).set(admin).send(body);
  const flagEvents = async () => (await t.prisma.outboxEvent.findMany({ where: { type: 'CompanyFlagChanged' }, orderBy: { createdAt: 'asc' } })).map((o) => o.payload as any);
  const audits = (action: string) => t.prisma.adminAuditLog.findMany({ where: { action } });
  const triggerByRejections = async (companyId: string) => {
    for (let i = 0; i < 3; i++) {
      await t.prisma.$transaction((tx) =>
        flags.recordRejection(tx, { companyId, jobId: randomUUID(), kind: 'AUTO_REJECTED', occurredAt: new Date(), sourceEventId: randomUUID(), correlationId: randomUUID() }),
      );
    }
    return t.prisma.queueItem.findFirstOrThrow({ where: { targetId: companyId, type: 'COMPANY_ACCOUNT', status: 'OPEN' } });
  };

  it('PUT active=true ⇒ 200 {changed:true}, set_by=ADMIN, E18 ตัวเดียว, audit FLAG_SET และไม่สร้างรายการคิว', async () => {
    const c = randomUUID();
    const res = await put(c, { active: true, reason: 'พบหลักฐานหลอกลวง' }).expect(200);
    expect(res.body).to.deep.equal({ company_id: c, active: true, changed: true });
    expect(await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } })).to.include({ underReview: true, setBy: 'ADMIN', setReason: 'พบหลักฐานหลอกลวง' });
    const ev = await flagEvents();
    expect(ev).to.have.length(1);
    expect(ev[0]).to.include({ company_id: c, active: true, set_by: 'ADMIN' });
    expect(await t.prisma.queueItem.count({ where: { targetId: c } })).to.equal(0);
    const [a] = await audits('FLAG_SET');
    expect(a).to.include({ adminId, targetType: 'company_flag', targetId: c, reason: 'พบหลักฐานหลอกลวง' });
  });

  it('PUT ซ้ำค่าเดิม ⇒ 200 {changed:false} ไม่มี Event/audit เพิ่ม; ไม่มี reason ⇒ 400', async () => {
    const c = randomUUID();
    await put(c, { active: true, reason: 'r' }).expect(200);
    const again = await put(c, { active: true, reason: 'r' }).expect(200);
    expect(again.body.changed).to.equal(false);
    expect(await flagEvents()).to.have.length(1);
    expect(await audits('FLAG_SET')).to.have.length(1);
    await put(c, { active: false }).expect(400);
    await put(c, { active: false, reason: '' }).expect(400);
    await put(c, { reason: 'r' }).expect(400);
    await http().put('/v1/admin/flags/companies/not-a-uuid/under-review').set(admin).send({ active: true, reason: 'r' }).expect(400);
  });

  it('PUT active=false ขณะมี COMPANY_ACCOUNT เปิด ⇒ ปิดรายการ ADMIN_CLEAR_FLAG, E18 active=false, audit FLAG_CLEAR', async () => {
    const c = randomUUID();
    const item = await triggerByRejections(c);
    const res = await put(c, { active: false, reason: 'ตรวจบัญชีแล้วปกติ' }).expect(200);
    expect(res.body.changed).to.equal(true);
    expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).to.include({ status: 'RESOLVED', resolution: 'ADMIN_CLEAR_FLAG' });
    const ev = await flagEvents();
    expect(ev[ev.length - 1]).to.include({ active: false, set_by: 'ADMIN' });
    expect(await audits('FLAG_CLEAR')).to.have.length(1);
  });

  it('company-clear-flag บนรายการที่ระบบสร้าง ⇒ 204 ธงถูกเคลียร์ + E18 active=false + audit; เรียกซ้ำ 409', async () => {
    const c = randomUUID();
    const item = await triggerByRejections(c);
    await http().post(`/v1/admin/queue/${item.id}/actions/company-clear-flag`).set(admin).send({ reason: 'ปกติ' }).expect(204);
    expect((await t.prisma.companyFlag.findUniqueOrThrow({ where: { companyId: c } })).underReview).to.equal(false);
    expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: item.id } })).to.include({ status: 'RESOLVED', resolution: 'ADMIN_CLEAR_FLAG' });
    const ev = await flagEvents();
    expect(ev[ev.length - 1]).to.include({ company_id: c, active: false });
    expect(await audits('FLAG_CLEAR')).to.have.length(1);
    const again = await http().post(`/v1/admin/queue/${item.id}/actions/company-clear-flag`).set(admin).send({});
    expect(again.status).to.equal(409);
    expect(again.body.error.code).to.equal('STATE_CONFLICT');
    // ไม่ส่ง body ได้ (reason ไม่บังคับ)
    const c2 = randomUUID();
    const item2 = await triggerByRejections(c2);
    await http().post(`/v1/admin/queue/${item2.id}/actions/company-clear-flag`).set(admin).expect(204);
  });

  it('company-clear-flag: ชนิดอื่น ⇒ 422 UNSUPPORTED_ITEM_TYPE; ไม่พบ ⇒ 404', async () => {
    const review = await t.prisma.$transaction((tx) =>
      queue.createItem(tx, { type: 'JOB_REVIEW', jobId: randomUUID(), companyId: randomUUID(), submissionId: randomUUID(), riskLevel: 'MEDIUM', fastTrack: false, origin: 'EVALUATION' }),
    );
    const res = await http().post(`/v1/admin/queue/${review.id}/actions/company-clear-flag`).set(admin).send({});
    expect(res.status).to.equal(422);
    expect(res.body.error.code).to.equal('UNSUPPORTED_ITEM_TYPE');
    await http().post(`/v1/admin/queue/${randomUUID()}/actions/company-clear-flag`).set(admin).send({}).expect(404);
  });

  it('GET: กรอง active, ค้นชื่อ (q), Pagination, เรียงใหม่สุดก่อน, ไม่แสดงบริษัทที่ไม่เคยติดธง', async () => {
    const a = randomUUID();
    const b = randomUUID();
    const never = randomUUID();
    await t.prisma.companySnapshot.createMany({
      data: [
        { companyId: a, name: 'บริษัท อัลฟ่า จำกัด', status: 'VERIFIED', entityVersion: 1 },
        { companyId: b, name: 'Beta Corp', status: 'VERIFIED', entityVersion: 1 },
      ],
    });
    await put(a, { active: true, reason: 'ra' }).expect(200);
    await new Promise((r) => setTimeout(r, 15));
    await put(b, { active: true, reason: 'rb' }).expect(200);
    await put(b, { active: false, reason: 'ok' }).expect(200);
    await put(never, { active: false, reason: 'x' }).expect(200); // ไม่เคยติด ⇒ ไม่ควรอยู่ในรายการ

    const list = (qs = '') => http().get(`/v1/admin/flags/companies${qs}`).set(admin).expect(200).then((r) => r.body);
    const all = await list();
    expect(all.meta).to.deep.equal({ page: 1, page_size: 20, total: 2 });
    expect(all.data.map((x: any) => x.company_id)).to.deep.equal([b, a]); // b ติดทีหลัง ⇒ มาก่อน
    expect(all.data[1]).to.have.all.keys('company_id', 'company_name', 'active', 'set_by', 'set_reason', 'set_at', 'cleared_at', 'trigger_count');
    expect(all.data[1]).to.include({ company_name: 'บริษัท อัลฟ่า จำกัด', active: true, set_by: 'ADMIN', set_reason: 'ra' });
    expect(all.data[0]).to.include({ company_name: 'Beta Corp', active: false });
    expect(all.data[0].cleared_at).to.be.a('string');

    expect((await list('?active=true')).data.map((x: any) => x.company_id)).to.deep.equal([a]);
    expect((await list('?active=false')).data.map((x: any) => x.company_id)).to.deep.equal([b]);
    expect((await list('?q=beta')).data.map((x: any) => x.company_id)).to.deep.equal([b]);
    expect((await list('?q=อัลฟ่า')).data.map((x: any) => x.company_id)).to.deep.equal([a]);
    const p2 = await list('?page=2&page_size=1');
    expect(p2.meta).to.deep.equal({ page: 2, page_size: 1, total: 2 });
    expect(p2.data.map((x: any) => x.company_id)).to.deep.equal([a]);
    await http().get('/v1/admin/flags/companies?active=maybe').set(admin).expect(400);
  });

  it('สิทธิ์: ไม่มี token 401; HR/นักศึกษา 403 ทุก endpoint', async () => {
    const c = randomUUID();
    const item = await triggerByRejections(randomUUID());
    const hr = { Authorization: `Bearer ${t.token({ role: 'COMPANY_HR', sub: randomUUID(), company_id: randomUUID() })}` };
    const student = { Authorization: `Bearer ${t.token({ role: 'STUDENT', sub: randomUUID() })}` };
    const calls: Array<['get' | 'put' | 'post', string]> = [
      ['get', '/v1/admin/flags/companies'],
      ['put', `/v1/admin/flags/companies/${c}/under-review`],
      ['post', `/v1/admin/queue/${item.id}/actions/company-clear-flag`],
    ];
    for (const [m, url] of calls) {
      await (http() as any)[m](url).expect(401);
      await (http() as any)[m](url).set(hr).send({ active: true, reason: 'x' }).expect(403);
      await (http() as any)[m](url).set(student).send({ active: true, reason: 'x' }).expect(403);
    }
  });
});
