import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { ReviewModule } from '../../src/review/review.module';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

describe('ReviewActions — publish-review / remove-review (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [ReviewModule], db });
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE review_moderations, review_reports, queue_items, outbox_events, status_history, admin_audit_log');
  });

  const http = () => request(t.app.getHttpServer());
  const who = (role: 'STUDENT' | 'COMPANY_HR' | 'PLATFORM_ADMIN', extra: { company_id?: string } = {}) => {
    const sub = randomUUID();
    return { sub, auth: { Authorization: `Bearer ${t.token({ role, sub, ...extra })}` } };
  };
  const act = (id: string, action: 'publish-review' | 'remove-review', auth: { Authorization: string } | undefined, body: object = {}) => {
    const r = http().post(`/v1/admin/queue/${id}/actions/${action}`);
    return (auth ? r.set(auth) : r).send(body);
  };
  const results = async () => (await t.prisma.outboxEvent.findMany({ where: { type: 'ReviewModerationResult' } })).map((o) => o.payload as any);

  /** รีวิวเผยแพร่แล้ว + รายการ REVIEW_REPORT (มีผู้รายงานหนึ่งคน) */
  const seedReported = async (status: 'PASSED' | 'ADMIN_PUBLISHED' = 'PASSED') => {
    const reviewId = randomUUID();
    const companyId = randomUUID();
    const studentUserId = randomUUID();
    await t.prisma.reviewModeration.create({
      data: { reviewId, companyId, studentUserId, rating: 1, outcomeLabel: 'PASS', body: 'แย่มาก', decision: 'PUBLISH', reasons: [], status },
    });
    const reporter = randomUUID();
    await t.prisma.reviewReport.create({ data: { reviewId, reporterUserId: reporter, reason: 'เหตุผลของผู้รายงานยาวพอ' } });
    const item = await t.prisma.queueItem.create({
      data: { type: 'REVIEW_REPORT', targetType: 'review', targetId: reviewId, companyId, origin: 'REVIEW_REPORT', dueAt: new Date(Date.now() + 1e8) },
    });
    return { reviewId, itemId: item.id, studentUserId, companyId, reporter };
  };
  const moderation = (reviewId: string) => t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId } });

  it('REVIEW_REPORT + publish ⇒ ADMIN_PUBLISHED, E10 ADMIN_PUBLISH [ADMIN], ปิดรายการ, history และ audit ครบ', async () => {
    const s = await seedReported();
    const admin = who('PLATFORM_ADMIN');
    const res = await act(s.itemId, 'publish-review', admin.auth);
    expect(res.status).to.equal(204);
    expect(await moderation(s.reviewId)).to.include({ status: 'ADMIN_PUBLISHED', decision: 'ADMIN_PUBLISH' });
    expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: s.itemId } })).to.include({ status: 'RESOLVED', resolution: 'ADMIN_PUBLISH' });
    const out = await results();
    expect(out).to.have.length(1);
    expect(out[0]).to.include({ review_id: s.reviewId, student_user_id: s.studentUserId, decision: 'ADMIN_PUBLISH', decided_by: 'ADMIN' });
    expect(out[0].reasons).to.deep.equal([{ code: 'REPORTED' }, { code: 'ADMIN' }]);
    const audit = await t.prisma.adminAuditLog.findMany();
    expect(audit).to.have.length(1);
    expect(audit[0]).to.include({ adminId: admin.sub, action: 'REVIEW_PUBLISH', targetType: 'review', targetId: s.reviewId });
    expect(await t.prisma.statusHistory.count({ where: { entityId: s.itemId, toStatus: 'RESOLVED', actorId: admin.sub } })).to.equal(1);
  });

  it('REVIEW_REPORT + remove (พร้อม detail) ⇒ ADMIN_REMOVED, E10 ADMIN_REMOVE พร้อม detail เหตุผล; audit REVIEW_REMOVE', async () => {
    const s = await seedReported();
    const res = await act(s.itemId, 'remove-review', who('PLATFORM_ADMIN').auth, { reason: 'มีข้อมูลติดต่อส่วนตัว' });
    expect(res.status).to.equal(204);
    expect(await moderation(s.reviewId)).to.include({ status: 'ADMIN_REMOVED', decision: 'ADMIN_REMOVE' });
    const out = await results();
    expect(out[0]).to.include({ decision: 'ADMIN_REMOVE', decided_by: 'ADMIN' });
    expect(out[0].reasons).to.deep.equal([{ code: 'REPORTED' }, { code: 'ADMIN', detail: 'มีข้อมูลติดต่อส่วนตัว' }]);
    expect((await t.prisma.adminAuditLog.findMany())[0]).to.include({ action: 'REVIEW_REMOVE', reason: 'มีข้อมูลติดต่อส่วนตัว' });
  });

  it('REVIEW_REPORT + publish (ยืนยันให้คงอยู่) ⇒ ADMIN_PUBLISHED, E10 reasons มี REPORTED และ ADMIN', async () => {
    const s = await seedReported();
    expect((await act(s.itemId, 'publish-review', who('PLATFORM_ADMIN').auth, { reason: 'ไม่พบความผิด' })).status).to.equal(204);
    expect(await moderation(s.reviewId)).to.include({ status: 'ADMIN_PUBLISHED', decision: 'ADMIN_PUBLISH' });
    const out = await results();
    expect(out[0].reasons).to.deep.equal([{ code: 'REPORTED' }, { code: 'ADMIN', detail: 'ไม่พบความผิด' }]);
  });

  it('REVIEW_REPORT + remove ⇒ ADMIN_REMOVED, E10 ADMIN_REMOVE มี REPORTED; หลังนั้นรายงานรีวิวไม่ได้ (422)', async () => {
    const s = await seedReported('ADMIN_PUBLISHED');
    expect((await act(s.itemId, 'remove-review', who('PLATFORM_ADMIN').auth, { reason: 'ใส่ร้ายบริษัท' })).status).to.equal(204);
    expect(await moderation(s.reviewId)).to.include({ status: 'ADMIN_REMOVED', decision: 'ADMIN_REMOVE' });
    const out = await results();
    expect(out[0].reasons).to.deep.equal([{ code: 'REPORTED' }, { code: 'ADMIN', detail: 'ใส่ร้ายบริษัท' }]);
    const res = await http().post(`/v1/reviews/${s.reviewId}/reports`).set(who('STUDENT').auth).send({ reason: 'รายงานหลังถูกลบแล้ว' });
    expect(res.status).to.equal(422);
  });

  it('หลัง publish ของ REVIEW_REPORT: ผู้ใช้ใหม่รายงานได้และเกิดรายการใหม่ ผู้เคยรายงานแล้วได้ 409', async () => {
    const s = await seedReported();
    await act(s.itemId, 'publish-review', who('PLATFORM_ADMIN').auth);
    const fresh = await http().post(`/v1/reviews/${s.reviewId}/reports`).set(who('STUDENT').auth).send({ reason: 'รายงานจากคนใหม่ยาวพอ' });
    expect(fresh.status).to.equal(201);
    expect(await t.prisma.queueItem.count({ where: { targetId: s.reviewId, type: 'REVIEW_REPORT', status: { not: 'RESOLVED' } } })).to.equal(1);
    const token = t.token({ role: 'STUDENT', sub: s.reporter });
    const again = await http().post(`/v1/reviews/${s.reviewId}/reports`).set({ Authorization: `Bearer ${token}` }).send({ reason: 'รายงานซ้ำจากคนเดิม' });
    expect(again.status).to.equal(409);
  });

  it('remove-review: ไม่มี/ว่าง/501 ตัว ⇒ 400 และรายการไม่เปลี่ยน; publish-review: reason 501 ตัว ⇒ 400', async () => {
    const s = await seedReported();
    const admin = who('PLATFORM_ADMIN');
    for (const body of [{}, { reason: '   ' }, { reason: 'ก'.repeat(501) }, { reason: 7 }]) {
      const res = await act(s.itemId, 'remove-review', admin.auth, body);
      expect(res.status, JSON.stringify(body).slice(0, 30)).to.equal(400);
      expect(res.body.error.code).to.equal('VALIDATION_FAILED');
    }
    expect((await act(s.itemId, 'publish-review', admin.auth, { reason: 'ก'.repeat(501) })).status).to.equal(400);
    expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: s.itemId } })).to.include({ status: 'OPEN' });
    expect(await moderation(s.reviewId)).to.include({ status: 'PASSED' });
    expect(await results()).to.have.length(0);
    expect((await act(s.itemId, 'remove-review', admin.auth, { reason: 'ก'.repeat(500) })).status).to.equal(204);
  });

  it('Minor #10: reason ของ Admin มี NUL ⇒ 400 ทั้ง publish และ remove และรายการไม่เปลี่ยน', async () => {
    const s = await seedReported();
    const admin = who('PLATFORM_ADMIN');
    expect((await act(s.itemId, 'remove-review', admin.auth, { reason: 'เหตุผล\u0000' })).status).to.equal(400);
    expect((await act(s.itemId, 'publish-review', admin.auth, { reason: 'เหตุผล\u0000' })).status).to.equal(400);
    expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: s.itemId } })).to.include({ status: 'OPEN' });
  });

  it('ชนิดรายการอื่น ⇒ 422 UNSUPPORTED_ITEM_TYPE; RESOLVED แล้ว ⇒ 409; ไม่รู้จัก id ⇒ 404', async () => {
    const other = await t.prisma.queueItem.create({
      data: { type: 'JOB_REVIEW', targetType: 'job', targetId: randomUUID(), origin: 'FLAGGED_COMPANY', dueAt: new Date(Date.now() + 1e8) },
    });
    const admin = who('PLATFORM_ADMIN');
    const wrong = await act(other.id, 'publish-review', admin.auth);
    expect(wrong.status).to.equal(422);
    expect(wrong.body.error.code).to.equal('UNSUPPORTED_ITEM_TYPE');

    const s = await seedReported();
    expect((await act(s.itemId, 'publish-review', admin.auth)).status).to.equal(204);
    const twice = await act(s.itemId, 'remove-review', admin.auth, { reason: 'ซ้ำ' });
    expect(twice.status).to.equal(409);
    expect(twice.body.error.code).to.equal('STATE_CONFLICT');
    expect(await results()).to.have.length(1);
    expect((await act(randomUUID(), 'publish-review', admin.auth)).status).to.equal(404);
  });

  it('Admin สองคนตัดสินรายการเดียวกันพร้อมกัน ⇒ คนหนึ่ง 204 อีกคน 409 และมี E10/audit ชุดเดียว', async () => {
    const s = await seedReported();
    const [a, b] = await Promise.all([
      act(s.itemId, 'publish-review', who('PLATFORM_ADMIN').auth),
      act(s.itemId, 'remove-review', who('PLATFORM_ADMIN').auth, { reason: 'ลบ' }),
    ]);
    expect([a.status, b.status].sort()).to.deep.equal([204, 409]);
    expect(await results()).to.have.length(1);
    expect(await t.prisma.adminAuditLog.count()).to.equal(1);
  });

  it('รีวิวถูกตัดสินไปแล้วโดยรายการอื่น (สถานะไม่ตรง) ⇒ 409 ไม่ส่ง E10 และรายการไม่ถูกปิด', async () => {
    const s = await seedReported();
    await t.prisma.reviewModeration.update({ where: { reviewId: s.reviewId }, data: { status: 'ADMIN_REMOVED' } });
    const res = await act(s.itemId, 'remove-review', who('PLATFORM_ADMIN').auth, { reason: 'ลบซ้ำ' });
    expect(res.status).to.equal(409);
    expect(await results()).to.have.length(0);
    expect(await t.prisma.queueItem.findUniqueOrThrow({ where: { id: s.itemId } })).to.include({ status: 'OPEN' });
  });

  it('สิทธิ์: STUDENT/HR ⇒ 403, ไม่มี token ⇒ 401', async () => {
    const s = await seedReported();
    expect((await act(s.itemId, 'publish-review', who('STUDENT').auth)).status).to.equal(403);
    expect((await act(s.itemId, 'remove-review', who('COMPANY_HR', { company_id: s.companyId }).auth, { reason: 'x' })).status).to.equal(403);
    expect((await act(s.itemId, 'publish-review', undefined)).status).to.equal(401);
  });
});
