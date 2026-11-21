import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import request from 'supertest';
import { QueueModule } from '../../src/queue/queue.module';
import { ReviewModule } from '../../src/review/review.module';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { QUEUE_ITEM_DETAIL, QUEUE_REVIEW_REPORT_ENTRY, QUEUE_REVIEW_VIEW, expectShape } from '../support/contract-shapes';

describe('GET /admin/queue — รายการรีวิว (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let admin: { Authorization: string };

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [QueueModule, ReviewModule], db });
    admin = { Authorization: `Bearer ${t.token({ role: 'PLATFORM_ADMIN', sub: randomUUID() })}` };
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE review_moderations, review_reports, queue_items, company_snapshots, outbox_events, status_history');
  });

  const http = () => request(t.app.getHttpServer());
  const title = 'โทร 081-234-5678';
  const body = 'บริษัทเรียกเก็บค่ามัดจำก่อนเริ่มงาน';

  const seed = async () => {
    const reviewId = randomUUID();
    const companyId = randomUUID();
    await t.prisma.companySnapshot.create({ data: { companyId, name: 'บริษัท รีวิว จำกัด', status: 'VERIFIED', entityVersion: 1 } });
    const item = await t.prisma.queueItem.create({
      data: { type: 'REVIEW_REPORT', targetType: 'review', targetId: reviewId, companyId, origin: 'REVIEW_REPORT', dueAt: new Date(Date.now() + 1e8) },
    });
    await t.prisma.reviewModeration.create({
      data: { reviewId, companyId, studentUserId: randomUUID(), rating: 2, outcomeLabel: 'FAIL', title, body, decision: 'PUBLISH', reasons: [], status: 'PASSED' },
    });
    return { reviewId, itemId: item.id, companyId };
  };

  it('REVIEW_REPORT: คืน review ครบ + review_reports + ฟิลด์ประกาศเป็นค่าว่าง', async () => {
    const s = await seed();
    const res = await http().get(`/v1/admin/queue/${s.itemId}`).set(admin);
    expect(res.status).to.equal(200);
    expect(res.body).to.include({ type: 'REVIEW_REPORT', target_id: s.reviewId, company_name: 'บริษัท รีวิว จำกัด', origin: 'REVIEW_REPORT' });
    expectShape(res.body, QUEUE_ITEM_DETAIL, 'GET /admin/queue/{id} (REVIEW_REPORT)');
    expectShape(res.body.review, QUEUE_REVIEW_VIEW, 'review');
    expect(res.body.review).to.include({ review_id: s.reviewId, rating: 2, outcome_label: 'FAIL', title, body, moderation_status: 'PASSED' });
    expect(res.body.review_reports).to.deep.equal([]);
    expect(res.body).to.include({ content: null });
    expect(res.body.reports).to.deep.equal([]);
  });

  it('REVIEW_REPORT: คืน review_reports ครบทุกคน (ตัวตนผู้รายงาน + เหตุผล) เรียงเก่า→ใหม่', async () => {
    const s = await seed();
    const a = randomUUID();
    const b = randomUUID();
    await t.prisma.reviewReport.create({ data: { reviewId: s.reviewId, reporterUserId: a, reason: 'เหตุผลแรกยาวพอ', createdAt: new Date(Date.now() - 5000) } });
    await t.prisma.reviewReport.create({ data: { reviewId: s.reviewId, reporterUserId: b, reason: 'เหตุผลที่สองยาวพอ' } });
    const res = await http().get(`/v1/admin/queue/${s.itemId}`).set(admin);
    expect(res.status).to.equal(200);
    expect(res.body.review_reports.map((r: any) => [r.reporter_user_id, r.reason])).to.deep.equal([
      [a, 'เหตุผลแรกยาวพอ'],
      [b, 'เหตุผลที่สองยาวพอ'],
    ]);
    for (const r of res.body.review_reports) expectShape(r, QUEUE_REVIEW_REPORT_ENTRY, 'review_reports[]');
    expect(res.body.review.moderation_status).to.equal('PASSED');
  });

  it('รายการประกาศเดิมไม่เปลี่ยนรูป: review เป็น null และ review_reports ว่าง', async () => {
    const item = await t.prisma.queueItem.create({
      data: { type: 'JOB_REVIEW', targetType: 'job', targetId: randomUUID(), origin: 'FLAGGED_COMPANY', dueAt: new Date(Date.now() + 1e8) },
    });
    const res = await http().get(`/v1/admin/queue/${item.id}`).set(admin);
    expect(res.status).to.equal(200);
    expect(res.body.review).to.equal(null);
    expect(res.body.review_reports).to.deep.equal([]);
  });

  it('GET /admin/queue?type=REVIEW_REPORT กรองได้และมี company_name', async () => {
    await seed();
    const res = await http().get('/v1/admin/queue?type=REVIEW_REPORT').set(admin);
    expect(res.status).to.equal(200);
    expect(res.body.data).to.have.length(1);
    expect(res.body.data[0]).to.include({ type: 'REVIEW_REPORT', company_name: 'บริษัท รีวิว จำกัด' });
    expect(res.body.data[0]).to.not.have.property('review');
  });

  it('สิทธิ์: STUDENT/HR เปิดรายละเอียดคิวไม่ได้ ⇒ 403', async () => {
    const s = await seed();
    for (const role of ['STUDENT', 'COMPANY_HR'] as const) {
      const res = await http().get(`/v1/admin/queue/${s.itemId}`).set({ Authorization: `Bearer ${t.token({ role, sub: randomUUID(), company_id: s.companyId })}` });
      expect(res.status, role).to.equal(403);
    }
  });
});
