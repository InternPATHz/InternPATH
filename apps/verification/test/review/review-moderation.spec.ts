import type { ReviewSubmittedPayload } from '@internpath/contracts';
import { expect } from 'chai';
import { ReviewModerationService } from '../../src/review/review-moderation.service';
import { ReviewModule } from '../../src/review/review.module';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { envelope, reviewSubmitted } from '../support/events';

describe('ReviewModerationService (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: ReviewModerationService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [ReviewModule], db });
    svc = t.app.get(ReviewModerationService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    await t.prisma.$executeRawUnsafe('TRUNCATE review_moderations, review_reports, queue_items, outbox_events, status_history');
  });

  const apply = (p: ReviewSubmittedPayload) =>
    t.prisma.$transaction((tx) => svc.handleReviewSubmitted(envelope('ReviewSubmitted', p, 'lifecycle'), tx));
  const results = async () => (await t.prisma.outboxEvent.findMany({ where: { type: 'ReviewModerationResult' } })).map((o) => o.payload as any);

  it('รีวิวสะอาด ⇒ PASSED + E10 PUBLISH (SYSTEM, reasons ว่าง, ส่ง student_user_id ต่อ) และไม่มีรายการคิว', async () => {
    const p = reviewSubmitted();
    await apply(p);
    const row = await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: p.review_id } });
    expect(row).to.include({ status: 'PASSED', decision: 'PUBLISH', companyId: p.company_id, studentUserId: p.student_user_id, rating: 5, outcomeLabel: 'PASS' });
    expect(row.queueItemId).to.equal(null);
    expect(await t.prisma.queueItem.count()).to.equal(0);
    const out = await results();
    expect(out).to.have.length(1);
    expect(out[0]).to.include({ review_id: p.review_id, student_user_id: p.student_user_id, decision: 'PUBLISH', decided_by: 'SYSTEM' });
    expect(out[0].reasons).to.deep.equal([]);
  });

  it('มีเบอร์โทร ⇒ HELD + รายการ REVIEW_HELD (NORMAL, 48 ชม.) + E10 HOLD ที่ไม่มีเนื้อรีวิว/เบอร์โทร', async () => {
    const p = reviewSubmitted({ content: { body: 'ติดต่อพี่เลี้ยงได้ที่ 081-234-5678 นะ' } });
    const before = Date.now();
    await apply(p);
    const row = await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: p.review_id } });
    expect(row).to.include({ status: 'HELD', decision: 'HOLD' });
    const item = await t.prisma.queueItem.findFirstOrThrow({ where: { targetId: p.review_id } });
    expect(item).to.include({ type: 'REVIEW_HELD', origin: 'REVIEW_SCAN', priority: 'NORMAL', targetType: 'review', companyId: p.company_id, status: 'OPEN' });
    expect(row.queueItemId).to.equal(item.id);
    expect(Math.abs(item.dueAt.getTime() - (before + 48 * 3600_000))).to.be.lessThan(60_000);
    expect(await t.prisma.statusHistory.count({ where: { entity: 'QUEUE_ITEM', entityId: item.id } })).to.equal(1);

    const out = await results();
    expect(out).to.have.length(1);
    expect(out[0]).to.include({ decision: 'HOLD', decided_by: 'SYSTEM' });
    expect(out[0].reasons).to.deep.equal([{ code: 'PERSONAL_CONTACT' }]);
    const json = JSON.stringify(out[0]);
    expect(json).to.not.include('081');
    expect(json).to.not.include('พี่เลี้ยง');
  });

  it('คำต้องห้าม ⇒ BLACKLIST; ทั้งสองอย่าง ⇒ สองเหตุผล; ข้อมูลติดต่อใน title อย่างเดียวก็ HOLD', async () => {
    const a = reviewSubmitted({ content: { body: 'เขาให้โอนเงินก่อนเริ่มงาน' } });
    const b = reviewSubmitted({ content: { body: 'เรียกค่าสมัคร โทร 081-234-5678' } });
    const c = reviewSubmitted({ content: { title: 'โทร 081-234-5678', body: 'ดีมาก' } });
    for (const p of [a, b, c]) await apply(p);
    const byReview = new Map((await results()).map((r) => [r.review_id, r]));
    expect(byReview.get(a.review_id).reasons).to.deep.equal([{ code: 'BLACKLIST' }]);
    expect(byReview.get(b.review_id).reasons).to.deep.equal([{ code: 'BLACKLIST' }, { code: 'PERSONAL_CONTACT' }]);
    expect(byReview.get(c.review_id).decision).to.equal('HOLD');
  });

  it('E09 ซ้ำด้วย review_id เดิม (event_id ใหม่ และพร้อมกัน 10 ครั้ง) ⇒ แถว/รายการคิว/E10 อย่างละหนึ่ง', async () => {
    const held = reviewSubmitted({ content: { body: 'โทร 081-234-5678' } });
    await Promise.all(Array.from({ length: 10 }, () => apply(held)));
    expect(await t.prisma.reviewModeration.count({ where: { reviewId: held.review_id } })).to.equal(1);
    expect(await t.prisma.queueItem.count({ where: { targetId: held.review_id } })).to.equal(1);
    expect((await results()).filter((r) => r.review_id === held.review_id)).to.have.length(1);

    const clean = reviewSubmitted();
    await apply(clean);
    await apply(clean);
    expect((await results()).filter((r) => r.review_id === clean.review_id)).to.have.length(1);
  });

  it('NUL และอักขระความกว้างศูนย์: ไม่ล้ม, เก็บข้อความ normalize แล้วไม่มี NUL, และยังจับเบอร์ที่สอดอักขระไว้ได้', async () => {
    const nul = reviewSubmitted({ content: { title: 'หัวข้อ\u0000', body: 'ดีมาก\u0000มาก' } });
    await apply(nul);
    const row = await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: nul.review_id } });
    expect(row.body).to.equal('ดีมากมาก');
    expect(row.title).to.equal('หัวข้อ');
    expect(row.status).to.equal('PASSED');

    const sneaky = reviewSubmitted({ content: { body: 'โทร 081-234​-5678 นะ' } });
    await apply(sneaky);
    const held = await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: sneaky.review_id } });
    expect(held.status).to.equal('HELD');
    expect(held.body).to.not.include('​');
  });

  it('title ว่าง/ช่องว่างล้วน ⇒ เก็บ title เป็น null', async () => {
    const p = reviewSubmitted({ content: { title: '   ', body: 'ดีมาก' } });
    await apply(p);
    expect((await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: p.review_id } })).title).to.equal(null);
  });
});
