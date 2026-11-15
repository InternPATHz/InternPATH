import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { expect } from 'chai';
import request from 'supertest';
import { ReviewModule } from '../../src/review/review.module';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const REASON = 'รีวิวนี้ใส่ร้ายบริษัทโดยไม่มีมูลความจริง';

describe('POST /reviews/{review_id}/reports (Postgres จริง)', function () {
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
    await t.prisma.$executeRawUnsafe('TRUNCATE review_moderations, review_reports, queue_items, outbox_events, status_history');
  });

  const http = () => request(t.app.getHttpServer());
  const who = (role: 'STUDENT' | 'COMPANY_HR' | 'ADVISOR' | 'PLATFORM_ADMIN', extra: { company_id?: string } = {}) => {
    const sub = randomUUID();
    return { sub, auth: { Authorization: `Bearer ${t.token({ role, sub, ...extra })}` } };
  };
  const seedReview = async (status: 'PASSED' | 'HELD' | 'ADMIN_PUBLISHED' | 'ADMIN_REMOVED' = 'PASSED', companyId = randomUUID()) => {
    const reviewId = randomUUID();
    await t.prisma.reviewModeration.create({
      data: {
        reviewId, companyId, studentUserId: randomUUID(), rating: 4, outcomeLabel: 'PASS', title: 'หัวข้อ', body: 'เนื้อหารีวิว',
        decision: status === 'HELD' ? 'HOLD' : 'PUBLISH', reasons: [], status,
      },
    });
    return { reviewId, companyId };
  };
  const post = (reviewId: string, auth: { Authorization: string } | undefined, body: unknown = { reason: REASON }) => {
    const r = http().post(`/v1/reviews/${reviewId}/reports`);
    return (auth ? r.set(auth) : r).send(body as object);
  };
  const openItems = (reviewId: string) => t.prisma.queueItem.findMany({ where: { targetId: reviewId, type: 'REVIEW_REPORT', status: { not: 'RESOLVED' } } });

  it('นักศึกษารายงานรีวิวที่เผยแพร่อยู่ ⇒ 201 {id,status:OPEN} + แถวรายงาน + รายการ REVIEW_REPORT หนึ่งรายการ', async () => {
    const { reviewId, companyId } = await seedReview();
    const res = await post(reviewId, who('STUDENT').auth);
    expect(res.status).to.equal(201);
    expect(res.body).to.have.keys(['id', 'status']);
    expect(res.body.status).to.equal('OPEN');
    expect(await t.prisma.reviewReport.count({ where: { reviewId } })).to.equal(1);
    const items = await openItems(reviewId);
    expect(items).to.have.length(1);
    expect(items[0]).to.include({ origin: 'REVIEW_REPORT', priority: 'NORMAL', targetType: 'review', companyId });
  });

  it('ผู้ใช้คนที่สองรายงานเพิ่ม ⇒ 201 แต่ยังมีรายการเปิดรายการเดียว; รีวิว ADMIN_PUBLISHED ก็รายงานได้', async () => {
    const { reviewId } = await seedReview('ADMIN_PUBLISHED');
    expect((await post(reviewId, who('STUDENT').auth)).status).to.equal(201);
    expect((await post(reviewId, who('STUDENT').auth)).status).to.equal(201);
    expect(await t.prisma.reviewReport.count({ where: { reviewId } })).to.equal(2);
    expect(await openItems(reviewId)).to.have.length(1);
  });

  it('ไม่รู้จักรีวิว ⇒ 404; HELD/ADMIN_REMOVED ⇒ 422 REVIEW_NOT_REPORTABLE ไม่มีแถวใหม่', async () => {
    expect((await post(randomUUID(), who('STUDENT').auth)).status).to.equal(404);
    for (const status of ['HELD', 'ADMIN_REMOVED'] as const) {
      const { reviewId } = await seedReview(status);
      const res = await post(reviewId, who('STUDENT').auth);
      expect(res.status, status).to.equal(422);
      expect(res.body.error.code).to.equal('REVIEW_NOT_REPORTABLE');
      expect(await t.prisma.reviewReport.count({ where: { reviewId } })).to.equal(0);
      expect(await t.prisma.queueItem.count({ where: { targetId: reviewId } })).to.equal(0);
    }
  });

  it('ผู้ใช้เดิมรายงานซ้ำ ⇒ 409 ALREADY_REPORTED', async () => {
    const { reviewId } = await seedReview();
    const user = who('STUDENT');
    expect((await post(reviewId, user.auth)).status).to.equal(201);
    const again = await post(reviewId, user.auth);
    expect(again.status).to.equal(409);
    expect(again.body.error.code).to.equal('ALREADY_REPORTED');
  });

  it('HR: บริษัทเดียวกัน ⇒ 201; คนละบริษัทหรือ token ไม่มี company_id ⇒ 403', async () => {
    const { reviewId, companyId } = await seedReview();
    expect((await post(reviewId, who('COMPANY_HR', { company_id: companyId }).auth)).status).to.equal(201);
    const other = await post(reviewId, who('COMPANY_HR', { company_id: randomUUID() }).auth);
    expect(other.status).to.equal(403);
    expect(other.body.error.code).to.equal('FORBIDDEN_ROLE');
    expect((await post(reviewId, who('COMPANY_HR').auth)).status).to.equal(403);
    expect(await t.prisma.reviewReport.count({ where: { reviewId } })).to.equal(1);
  });

  it('role อื่น ⇒ 403; ไม่มี token ⇒ 401; reviewId ไม่ใช่ UUID ⇒ 400', async () => {
    const { reviewId } = await seedReview();
    expect((await post(reviewId, who('ADVISOR').auth)).status).to.equal(403);
    expect((await post(reviewId, who('PLATFORM_ADMIN').auth)).status).to.equal(403);
    expect((await post(reviewId, undefined)).status).to.equal(401);
    expect((await post('ไม่ใช่-uuid', who('STUDENT').auth)).status).to.equal(400);
  });

  it('reason ผิดรูป (9 ตัว, 1001 ตัว, ช่องว่างล้วน, ไม่ใช่ string, ไม่มี) ⇒ 400 และไม่มีแถว/รายการ', async () => {
    const { reviewId } = await seedReview();
    for (const body of [{ reason: 'สั้นไป-9' }, { reason: 'ก'.repeat(1001) }, { reason: '          ' }, { reason: 12345 }, {}]) {
      const res = await post(reviewId, who('STUDENT').auth, body);
      expect(res.status, JSON.stringify(body).slice(0, 40)).to.equal(400);
      expect(res.body.error.code).to.equal('VALIDATION_FAILED');
    }
    expect(await t.prisma.reviewReport.count()).to.equal(0);
    expect(await t.prisma.queueItem.count()).to.equal(0);
    expect((await post(reviewId, who('STUDENT').auth, { reason: 'ก'.repeat(10) })).status).to.equal(201);
  });

  it('10 ผู้ใช้รายงานพร้อมกัน ⇒ 10 แถว รายการเปิดหนึ่งรายการ', async () => {
    const { reviewId } = await seedReview();
    const results = await Promise.all(Array.from({ length: 10 }, () => post(reviewId, who('STUDENT').auth)));
    expect(results.map((r) => r.status)).to.deep.equal(Array(10).fill(201));
    expect(await t.prisma.reviewReport.count({ where: { reviewId } })).to.equal(10);
    expect(await openItems(reviewId)).to.have.length(1);
  });

  it('รีวิวถูกลบระหว่างรายงานพร้อมกัน ⇒ ไม่มี 201 หลังรีวิวเป็น ADMIN_REMOVED และไม่ทิ้งรายการเปิดค้างนอกเหนือจากที่ผู้ที่ได้ 201 สร้าง', async () => {
    const { reviewId } = await seedReview();
    await t.prisma.reviewModeration.update({ where: { reviewId }, data: { status: 'ADMIN_REMOVED' } });
    const res = await post(reviewId, who('STUDENT').auth);
    expect(res.status).to.equal(422);
    expect(await t.prisma.reviewReport.count({ where: { reviewId } })).to.equal(0);
  });

  it('ไม่ log reason ของรายงาน', async () => {
    const { reviewId } = await seedReview();
    const marker = 'MARKER-ลับ-ห้ามหลุด-1234567890';
    const seen: string[] = [];
    const methods = ['log', 'debug', 'warn', 'error', 'verbose'] as const;
    const originals = methods.map((m) => Logger.prototype[m]);
    methods.forEach((m) => {
      (Logger.prototype as any)[m] = (...args: unknown[]) => void seen.push(args.map((a) => JSON.stringify(a)).join(' '));
    });
    try {
      const res = await post(reviewId, who('STUDENT').auth, { reason: `${marker} ${REASON}` });
      expect(res.status).to.equal(201);
    } finally {
      methods.forEach((m, i) => ((Logger.prototype as any)[m] = originals[i]));
    }
    expect(seen.join('\n')).to.not.include(marker);
  });
});
