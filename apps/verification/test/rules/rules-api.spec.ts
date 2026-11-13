import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { AuditModule } from '../../src/audit/audit.module';
import { RulesModule } from '../../src/rules/rules.module';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

describe('rules API: /admin/blacklist, /admin/risk-rules (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let admin: { Authorization: string };
  let adminId: string;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [AuditModule, RulesModule], db });
    adminId = randomUUID();
    admin = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN', sub: adminId })}` };
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const http = () => request(t.app.getHttpServer());
  const auditCount = (action: string) => t.prisma.adminAuditLog.count({ where: { action } });

  it('สิทธิ์: ทุก endpoint ไม่มี token 401, HR/นักศึกษา 403', async () => {
    const hr = { Authorization: `Bearer ${t.token({ role: 'COMPANY_HR', company_id: randomUUID() })}` };
    const student = { Authorization: `Bearer ${t.token({ role: 'STUDENT' })}` };
    const id = randomUUID();
    const calls: Array<[string, string]> = [
      ['get', '/v1/admin/blacklist'],
      ['post', '/v1/admin/blacklist'],
      ['patch', `/v1/admin/blacklist/${id}`],
      ['delete', `/v1/admin/blacklist/${id}`],
      ['post', '/v1/admin/blacklist/test'],
      ['get', '/v1/admin/risk-rules'],
      ['put', '/v1/admin/risk-rules'],
    ];
    for (const [method, url] of calls) {
      await (http() as any)[method](url).expect(401);
      await (http() as any)[method](url).set(hr).expect(403);
      await (http() as any)[method](url).set(student).expect(403);
    }
  });

  describe('blacklist', () => {
    it('GET: รายการ + Pagination + ตัวกรอง severity/enabled/q', async () => {
      const all = await http().get('/v1/admin/blacklist?page_size=100').set(admin).expect(200);
      expect(all.body.meta).to.deep.equal({ page: 1, page_size: 100, total: 23 });
      expect(all.body.data[0]).to.have.all.keys('id', 'term', 'severity', 'weight', 'category', 'enabled', 'created_at');
      expect((await http().get('/v1/admin/blacklist?severity=SOFT').set(admin).expect(200)).body.meta.total).to.equal(6);
      expect((await http().get('/v1/admin/blacklist?q=มัดจำ').set(admin).expect(200)).body.meta.total).to.equal(2);
      expect((await http().get('/v1/admin/blacklist?enabled=false').set(admin).expect(200)).body.meta.total).to.equal(0);
    });

    it('POST: HARD ที่มี weight → 400; SOFT ไม่มี weight → 400; severity ผิด → 400; term ว่าง → 400', async () => {
      for (const body of [
        { term: 'abc', severity: 'HARD', weight: 5 },
        { term: 'abc', severity: 'SOFT' },
        { term: 'abc', severity: 'MEDIUM' },
        { term: '  ', severity: 'HARD' },
        { term: 'abc', severity: 'SOFT', weight: -1 },
      ]) {
        const r = await http().post('/v1/admin/blacklist').set(admin).send(body).expect(400);
        expect(r.body.error.code, JSON.stringify(body)).to.equal('VALIDATION_FAILED');
      }
    });

    it('POST สำเร็จ → 201 และมีแถว audit BLACKLIST_CREATE; term ซ้ำ (ไม่สนตัวพิมพ์) → 409 TERM_EXISTS', async () => {
      const before = await auditCount('BLACKLIST_CREATE');
      const res = await http()
        .post('/v1/admin/blacklist')
        .set(admin)
        .send({ term: 'ทดสอบคำ', severity: 'HARD', category: 'TEST' })
        .expect(201);
      expect(res.body).to.include({ term: 'ทดสอบคำ', severity: 'HARD', weight: null, category: 'TEST', enabled: true });
      expect(await auditCount('BLACKLIST_CREATE')).to.equal(before + 1);
      const log = await t.prisma.adminAuditLog.findFirst({ where: { action: 'BLACKLIST_CREATE' }, orderBy: { occurredAt: 'desc' } });
      expect(log!.adminId).to.equal(adminId);

      await http().post('/v1/admin/blacklist').set(admin).send({ term: 'MLM', severity: 'HARD' }).expect(409);
      const dup = await http().post('/v1/admin/blacklist').set(admin).send({ term: 'ทดสอบคำ', severity: 'HARD' }).expect(409);
      expect(dup.body.error.code).to.equal('TERM_EXISTS');
    });

    it('PATCH enabled=false แล้ว /test ที่มีคำนั้น → ไม่เจอคำนั้น; PATCH weight บน HARD → 400; id ที่ไม่มี → 404', async () => {
      const created = await http().post('/v1/admin/blacklist').set(admin).send({ term: 'คำชั่วคราว', severity: 'HARD' }).expect(201);
      const id = created.body.id;
      const hit = await http().post('/v1/admin/blacklist/test').set(admin).send({ text: 'เรามีคำชั่วคราว ให้ทดลอง' }).expect(200);
      expect(hit.body.matched_keywords.map((m: any) => m.term)).to.include('คำชั่วคราว');

      await http().patch(`/v1/admin/blacklist/${id}`).set(admin).send({ weight: 3 }).expect(400);
      const upd = await http().patch(`/v1/admin/blacklist/${id}`).set(admin).send({ enabled: false }).expect(200);
      expect(upd.body.enabled).to.equal(false);
      expect(await auditCount('BLACKLIST_UPDATE')).to.be.greaterThan(0);

      const miss = await http().post('/v1/admin/blacklist/test').set(admin).send({ text: 'เรามีคำชั่วคราว ให้ทดลอง' }).expect(200);
      expect(miss.body.matched_keywords.map((m: any) => m.term)).to.not.include('คำชั่วคราว');
      await http().patch(`/v1/admin/blacklist/${randomUUID()}`).set(admin).send({ enabled: true }).expect(404);
    });

    it('DELETE → 204 และหาย; ครั้งที่สอง → 404; มีแถว audit BLACKLIST_DELETE', async () => {
      const created = await http().post('/v1/admin/blacklist').set(admin).send({ term: 'ลบทิ้ง', severity: 'SOFT', weight: 5 }).expect(201);
      await http().delete(`/v1/admin/blacklist/${created.body.id}`).set(admin).expect(204);
      await http().delete(`/v1/admin/blacklist/${created.body.id}`).set(admin).expect(404);
      expect(await auditCount('BLACKLIST_DELETE')).to.equal(1);
      expect(await t.prisma.blacklistTerm.count({ where: { term: 'ลบทิ้ง' } })).to.equal(0);
    });
  });

  describe('POST /admin/blacklist/test', () => {
    it('"ไม่มีค่ามัดจำ" → PENDING_REVIEW พร้อม matched_keywords[0].negated=true; ไม่บันทึกอะไรเลย', async () => {
      const count = async () =>
        (await t.prisma.evaluation.count()) + (await t.prisma.queueItem.count()) + (await t.prisma.outboxEvent.count()) + (await t.prisma.adminAuditLog.count());
      const before = await count();
      const res = await http().post('/v1/admin/blacklist/test').set(admin).send({ text: 'ไม่มีค่ามัดจำ' }).expect(200);
      expect(res.body).to.include({ decision: 'PENDING_REVIEW', risk_level: 'MEDIUM' });
      expect(res.body).to.have.all.keys('decision', 'risk_level', 'risk_score', 'matched_keywords', 'reasons');
      expect(res.body.matched_keywords[0].negated).to.equal(true);
      expect(await count()).to.equal(before);
    });

    it('ข้อความปกติสั้นๆ ไม่ถูกนับว่า "รายละเอียดสั้นเกินไป" (score 0, APPROVE); text ว่าง/ไม่ใช่ string → 400', async () => {
      const ok = await http().post('/v1/admin/blacklist/test').set(admin).send({ text: 'ฝึกงานด้านเว็บ' }).expect(200);
      expect(ok.body).to.include({ decision: 'APPROVE', risk_score: 0 });
      await http().post('/v1/admin/blacklist/test').set(admin).send({}).expect(400);
      await http().post('/v1/admin/blacklist/test').set(admin).send({ text: 123 }).expect(400);
    });
  });

  describe('risk-rules', () => {
    it('GET: กฎครบ 8 แถว (รวมที่ปิด) และ negation cues พร้อม id', async () => {
      const res = await http().get('/v1/admin/risk-rules').set(admin).expect(200);
      expect(res.body.rules).to.have.length(8);
      expect(res.body.rules[0]).to.have.all.keys('code', 'weight', 'params', 'enabled');
      expect(res.body.negation_cues).to.have.length(8);
      expect(res.body.negation_cues[0]).to.have.all.keys('id', 'cue', 'enabled');
    });

    it('PUT: แก้ CONTACT_IN_TEXT.weight=10 แล้ว /test กับเบอร์โทรได้ score เปลี่ยนตาม; มีแถว audit พร้อม before/after', async () => {
      const phone = { text: 'โทร 081-234-5678' };
      expect((await http().post('/v1/admin/blacklist/test').set(admin).send(phone).expect(200)).body.risk_score).to.equal(45);
      const put = await http().put('/v1/admin/risk-rules').set(admin).send({ rules: [{ code: 'CONTACT_IN_TEXT', weight: 10 }] }).expect(200);
      expect(put.body.rules.find((r: any) => r.code === 'CONTACT_IN_TEXT').weight).to.equal(10);
      expect((await http().post('/v1/admin/blacklist/test').set(admin).send(phone).expect(200)).body.risk_score).to.equal(10);

      const log = await t.prisma.adminAuditLog.findFirst({ where: { action: 'RISK_RULES_UPDATE' } });
      expect(log).to.not.equal(null);
      expect(JSON.stringify(log!.before)).to.include('45');
      expect(JSON.stringify(log!.after)).to.include('10');
      expect(log!.adminId).to.equal(adminId);
    });

    it('PUT: ปิดกฎได้ (enabled=false), แก้ params ได้ (NEGATION_WINDOW.max_gap), เพิ่ม/ปิด negation cue ได้', async () => {
      const put = await http()
        .put('/v1/admin/risk-rules')
        .set(admin)
        .send({
          rules: [
            { code: 'NO_ALLOWANCE', enabled: false },
            { code: 'NEGATION_WINDOW', params: { max_gap: 3 } },
          ],
          negation_cues: [{ cue: 'ไม่ใช่', enabled: true }, { cue: 'no', enabled: false }],
        })
        .expect(200);
      expect(put.body.rules.find((r: any) => r.code === 'NO_ALLOWANCE').enabled).to.equal(false);
      expect(put.body.rules.find((r: any) => r.code === 'NEGATION_WINDOW').params.max_gap).to.equal(3);
      expect(put.body.negation_cues.map((c: any) => c.cue)).to.include('ไม่ใช่');
      expect(put.body.negation_cues.find((c: any) => c.cue === 'no').enabled).to.equal(false);
    });

    it('PUT: code ที่ไม่มี → 400; weight ติดลบ/ไม่ใช่จำนวนเต็ม → 400; max_gap นอก 0–100 → 400; ไม่เปลี่ยนค่าเมื่อ 400', async () => {
      const before = (await http().get('/v1/admin/risk-rules').set(admin).expect(200)).body;
      for (const body of [
        { rules: [{ code: 'NOPE', weight: 1 }] },
        { rules: [{ code: 'CONTACT_IN_TEXT', weight: -1 }] },
        { rules: [{ code: 'CONTACT_IN_TEXT', weight: 1.5 }] },
        { rules: [{ code: 'NEGATION_WINDOW', params: { max_gap: 101 } }] },
        { rules: [{ code: 'NEGATION_WINDOW', params: { max_gap: -1 } }] },
        { rules: [{ code: 'CONTACT_IN_TEXT', weight: 5 }, { code: 'NOPE', weight: 1 }] },
      ]) {
        const r = await http().put('/v1/admin/risk-rules').set(admin).send(body).expect(400);
        expect(r.body.error.code, JSON.stringify(body)).to.equal('VALIDATION_FAILED');
      }
      const after = (await http().get('/v1/admin/risk-rules').set(admin).expect(200)).body;
      expect(after).to.deep.equal(before);
    });
  });
});
