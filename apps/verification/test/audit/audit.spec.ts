import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { AuditModule } from '../../src/audit/audit.module';
import { AuditService } from '../../src/audit/audit.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

describe('audit (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let audit: AuditService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [AuditModule], db });
    audit = t.app.get(AuditService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const record = (e: Parameters<AuditService['record']>[1]) => t.prisma.$transaction((tx) => audit.record(tx, e));

  it('record แล้ว list อ่านได้ (เรียงใหม่ไปเก่า) ตัวกรองทุกตัวทำงานและ Pagination ตาม meta', async () => {
    const adminA = randomUUID();
    const adminB = randomUUID();
    await record({ adminId: adminA, action: 'BLACKLIST_CREATE', targetType: 'blacklist_term', targetId: randomUUID(), after: { term: 'x' } });
    await new Promise((r) => setTimeout(r, 15));
    const cut = new Date();
    await new Promise((r) => setTimeout(r, 15));
    await record({ adminId: adminB, action: 'QUEUE_APPROVE', targetType: 'queue_item', targetId: randomUUID(), before: { s: 1 }, after: { s: 2 }, reason: 'ok' });
    await record({ adminId: adminB, action: 'QUEUE_REJECT', targetType: 'queue_item', targetId: randomUUID(), reason: 'bad' });

    const all = await audit.list({ page: 1, page_size: 20 });
    expect(all.meta).to.deep.equal({ page: 1, page_size: 20, total: 3 });
    expect(all.data.map((r) => r.action)).to.deep.equal(['QUEUE_REJECT', 'QUEUE_APPROVE', 'BLACKLIST_CREATE']);
    expect(all.data[1]).to.include({ admin_id: adminB, target_type: 'queue_item', reason: 'ok' });
    expect(all.data[1].before).to.deep.equal({ s: 1 });

    expect((await audit.list({ page: 1, page_size: 20, actor: adminA })).data).to.have.length(1);
    expect((await audit.list({ page: 1, page_size: 20, action: 'QUEUE_APPROVE' })).data).to.have.length(1);
    expect((await audit.list({ page: 1, page_size: 20, target_type: 'queue_item' })).data).to.have.length(2);
    expect((await audit.list({ page: 1, page_size: 20, from: cut })).data).to.have.length(2);
    expect((await audit.list({ page: 1, page_size: 20, to: cut })).data).to.have.length(1);

    const p2 = await audit.list({ page: 2, page_size: 2 });
    expect(p2.meta).to.deep.equal({ page: 2, page_size: 2, total: 3 });
    expect(p2.data).to.have.length(1);
  });

  it('correlationId ที่ไม่ใช่ UUID ไม่ทำให้ record ล้ม', async () => {
    await record({ adminId: randomUUID(), action: 'X', targetType: 't', targetId: 'risk_rules', correlationId: 'abc-123' });
  });

  describe('GET /v1/admin/audit', () => {
    it('ไม่มี token → 401; STUDENT/COMPANY_HR → 403', async () => {
      const server = t.app.getHttpServer();
      await request(server).get('/v1/admin/audit').expect(401);
      await request(server).get('/v1/admin/audit').set('Authorization', `Bearer ${t.token({ role: 'STUDENT' })}`).expect(403);
      await request(server)
        .get('/v1/admin/audit')
        .set('Authorization', `Bearer ${t.token({ role: 'COMPANY_HR', company_id: randomUUID() })}`)
        .expect(403);
    });

    it('PLATFORM_ADMIN → 200 พร้อม { data, meta } แบบ snake_case และกรองได้', async () => {
      const res = await request(t.app.getHttpServer())
        .get('/v1/admin/audit?action=QUEUE_APPROVE&page_size=5')
        .set('Authorization', `Bearer ${t.token({ role: 'PLATFORM_ADMIN' })}`)
        .expect(200);
      expect(res.body.meta).to.deep.equal({ page: 1, page_size: 5, total: 1 });
      expect(res.body.data[0]).to.have.all.keys(
        'id', 'admin_id', 'action', 'target_type', 'target_id', 'before', 'after', 'reason', 'correlation_id', 'occurred_at',
      );
    });

    it('page_size=101 → 400 VALIDATION_FAILED; page=0 → 400; พารามิเตอร์ที่ไม่รู้จัก → 400', async () => {
      const auth = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN' })}` };
      const server = t.app.getHttpServer();
      const r = await request(server).get('/v1/admin/audit?page_size=101').set(auth).expect(400);
      expect(r.body.error.code).to.equal('VALIDATION_FAILED');
      await request(server).get('/v1/admin/audit?page=0').set(auth).expect(400);
      await request(server).get('/v1/admin/audit?bogus=1').set(auth).expect(400);
    });
  });
});
