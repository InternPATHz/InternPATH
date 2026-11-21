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

  it('ข้อความที่เคยถูกพัก (เบอร์โทร/คำต้องห้าม) ⇒ เผยแพร่ทันทีเหมือนกัน: ไม่มีรายการคิว ไม่มี HOLD และ E10 ไม่มีเนื้อรีวิว', async () => {
    const cases = [
      reviewSubmitted({ content: { body: 'ติดต่อพี่เลี้ยงได้ที่ 081-234-5678 นะ' } }),
      reviewSubmitted({ content: { body: 'เขาให้โอนเงินก่อนเริ่มงาน' } }),
      reviewSubmitted({ content: { title: 'โทร 081-234-5678', body: 'ดีมาก' } }),
    ];
    for (const p of cases) await apply(p);
    expect(await t.prisma.queueItem.count()).to.equal(0);
    const out = await results();
    expect(out).to.have.length(3);
    for (const r of out) {
      expect(r).to.include({ decision: 'PUBLISH', decided_by: 'SYSTEM' });
      expect(r.reasons).to.deep.equal([]);
    }
    const json = JSON.stringify(out);
    expect(json).to.not.include('081');
    expect(json).to.not.include('พี่เลี้ยง');
    const rows = await t.prisma.reviewModeration.findMany();
    expect(rows.every((r) => r.status === 'PASSED' && r.decision === 'PUBLISH')).to.equal(true);
  });

  it('E09 ซ้ำด้วย review_id เดิม (event_id ใหม่ และพร้อมกัน 10 ครั้ง) ⇒ แถว/E10 อย่างละหนึ่ง', async () => {
    const held = reviewSubmitted({ content: { body: 'โทร 081-234-5678' } });
    await Promise.all(Array.from({ length: 10 }, () => apply(held)));
    expect(await t.prisma.reviewModeration.count({ where: { reviewId: held.review_id } })).to.equal(1);
    expect((await results()).filter((r) => r.review_id === held.review_id)).to.have.length(1);

    const clean = reviewSubmitted();
    await apply(clean);
    await apply(clean);
    expect((await results()).filter((r) => r.review_id === clean.review_id)).to.have.length(1);
  });

  it('NUL และอักขระความกว้างศูนย์: ไม่ล้ม, เก็บข้อความ normalize แล้วไม่มี NUL และไม่มีอักขระความกว้างศูนย์', async () => {
    const nul = reviewSubmitted({ content: { title: 'หัวข้อ\u0000', body: 'ดีมาก\u0000มาก' } });
    await apply(nul);
    const row = await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: nul.review_id } });
    expect(row.body).to.equal('ดีมากมาก');
    expect(row.title).to.equal('หัวข้อ');
    expect(row.status).to.equal('PASSED');

    const sneaky = reviewSubmitted({ content: { body: 'โทร 081-234​-5678 นะ' } });
    await apply(sneaky);
    const held = await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: sneaky.review_id } });
    expect(held.status).to.equal('PASSED');
    expect(held.body).to.not.include('​');
  });

  it('title ว่าง/ช่องว่างล้วน ⇒ เก็บ title เป็น null', async () => {
    const p = reviewSubmitted({ content: { title: '   ', body: 'ดีมาก' } });
    await apply(p);
    expect((await t.prisma.reviewModeration.findUniqueOrThrow({ where: { reviewId: p.review_id } })).title).to.equal(null);
  });
});
