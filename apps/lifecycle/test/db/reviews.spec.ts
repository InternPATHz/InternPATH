import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { InvalidMessageError, OutboxWriter, configureApp, processDelivery } from '@internpath/common';
import type { EventEnvelope, ReviewModerationResultPayload } from '@internpath/contracts';
import { expect } from 'chai';
import request from 'supertest';
import type { ApplicationStatus } from '../../generated/client';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { ReviewModerationService } from '../../src/modules/reviews/review-moderation.service';
import { ReviewsModule } from '../../src/modules/reviews/reviews.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { Tx } from '../../src/prisma/types';
import { addDays, bangkokToday } from '../../src/state-machine/dates';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity } from '../support/profile-resume-fakes';

@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class OutboxOnlyModule {}

type Decision = ReviewModerationResultPayload['decision'];

/*
 * หัวข้อ 1.8 — รีวิวบริษัท (api-contract §7.6, README §5.5, event-contract E09–E11) ผ่าน HTTP จริง + Postgres จริง
 * Consumer E10 ทดสอบผ่าน `processDelivery` ของ libs/common (processed_events + Transaction เดียวกับแอปจริง) โดยไม่ต่อ RabbitMQ
 */
describe('Lifecycle 1.8 — รีวิวบริษัท (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  let moderation: ReviewModerationService;
  const identity = new FakeIdentity();
  const http = () => request(app.getHttpServer());

  const hrUser = randomUUID();
  let student: string;
  let companyId: string;
  const today = () => bangkokToday(new Date());

  const asStudent = (sub = student) => bearer({ role: 'STUDENT', sub });
  const asHr = (company = companyId) => bearer({ role: 'COMPANY_HR', sub: hrUser, company_id: company, company_role: 'MEMBER' });

  before(async function () {
    database = await createTestDatabase('lc_review');
    if (!database) this.skip();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_PUBLIC_KEY: TEST_JWT.publicKey, LIFECYCLE_DATABASE_URL: database!.url })],
        }),
        PrismaModule,
        LifecycleConfigModule,
        InternalModule,
        OutboxOnlyModule,
        ReviewsModule,
      ],
    })
      .overrideProvider(IdentityInternalClient)
      .useValue(identity)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
    moderation = app.get(ReviewModerationService);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(() => {
    identity.students.clear();
    identity.unavailable = false;
    identity.nameCalls = [];
    student = randomUUID();
    companyId = randomUUID();
    identity.setStudent(student, { full_name: 'สมหญิง รักงาน', major: 'วิทยาการคอมพิวเตอร์', year_level: 4 });
  });

  /** ใบสมัครที่จบแล้ว + ผลประเมิน (ถ้าให้) */
  const seed = async (status: ApplicationStatus, data: Record<string, unknown> = {}, evaluation?: 'PASS' | 'FAIL') => {
    const end = addDays(today(), -1);
    const row = await prisma.application.create({
      data: {
        jobId: randomUUID(),
        companyId,
        studentUserId: student,
        status,
        startDate: addDays(end, -60),
        endDate: end,
        actualStartDate: addDays(end, -60),
        actualEndDate: end,
        ...data,
      },
    });
    if (evaluation) {
      await prisma.evaluation.create({
        data: { applicationId: row.id, round: 1, result: evaluation, reason: evaluation === 'FAIL' ? 'x' : null, evaluatedBy: hrUser },
      });
    }
    return row;
  };

  const write = (id: string, body: Record<string, unknown> = {}, token = asStudent()) =>
    http()
      .post(`/v1/applications/${id}/review`)
      .set('Authorization', token)
      .send({ rating: 4, title: 'ดีมาก', body: 'ได้เรียนรู้งานจริง พี่เลี้ยงใส่ใจ', anonymous: false, ...body });

  /** ส่ง E10 ผ่าน processDelivery (กันซ้ำด้วย processed_events แบบเดียวกับแอปจริง) */
  const deliver = async (
    reviewId: string,
    decision: Decision,
    opts: { eventId?: string; decidedBy?: 'SYSTEM' | 'ADMIN'; payload?: Record<string, unknown> } = {},
  ) => {
    const envelope: EventEnvelope<string, unknown> = {
      event_id: opts.eventId ?? randomUUID(),
      type: 'ReviewModerationResult',
      version: 1,
      occurred_at: new Date().toISOString(),
      producer: 'verification',
      correlation_id: randomUUID(),
      payload: opts.payload ?? {
        review_id: reviewId,
        student_user_id: student,
        decision,
        reasons: decision === 'HOLD' ? [{ code: 'PERSONAL_CONTACT', detail: 'มีเบอร์โทร 08x' }] : [],
        decided_by: opts.decidedBy ?? (decision.startsWith('ADMIN') ? 'ADMIN' : 'SYSTEM'),
        decided_at: new Date().toISOString(),
      },
    } as EventEnvelope<string, unknown>;
    return processDelivery<Tx>({
      raw: Buffer.from(JSON.stringify(envelope)),
      retryCount: 0,
      queue: 'lifecycle.verification.ReviewModerationResult',
      maxRetries: 3,
      runInTransaction: (fn) => prisma.$transaction(fn),
      sub: {
        producer: 'verification',
        type: 'ReviewModerationResult',
        handler: async (env, tx) => {
          await moderation.handle(env as EventEnvelope<string, ReviewModerationResultPayload>, tx);
        },
      },
    });
  };

  const reviewStatus = async (id: string) => (await prisma.review.findUniqueOrThrow({ where: { id } })).status;
  const stats = () => prisma.companyReviewStats.findUnique({ where: { companyId } });
  const publishedEvents = async () =>
    (await prisma.outboxEvent.findMany({ where: { type: 'ReviewPublished', aggregateId: companyId }, orderBy: { createdAt: 'asc' } })).map(
      (e) => e.payload as Record<string, unknown>,
    );

  const submitted = async (body: Record<string, unknown> = {}) => {
    const row = await seed('EVALUATED_PASS', {}, 'PASS');
    return (await write(row.id, body).expect(201)).body as { id: string };
  };

  // ------------------------------------------------------------------
  describe('POST /applications/{id}/review', () => {
    it('EVALUATED_PASS ⇒ 201 SUBMITTED + display_major/year + status_history + E09 (มี student_user_id, ไม่มีชื่อ)', async () => {
      const row = await seed('EVALUATED_PASS', {}, 'PASS');
      const res = await write(row.id, { title: '  ดีมาก  ' }).expect(201);
      expect(res.body).to.include({ application_id: row.id, company_id: companyId, rating: 4, title: 'ดีมาก', anonymous: false, status: 'SUBMITTED' });

      const review = await prisma.review.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(review).to.include({ outcomeLabel: 'PASS', displayMajor: 'วิทยาการคอมพิวเตอร์', displayYear: 4, studentUserId: student });

      const history = await prisma.statusHistory.findMany({ where: { entity: 'REVIEW', entityId: review.id } });
      expect(history).to.have.length(1);
      expect(history[0]).to.include({ fromStatus: null, toStatus: 'SUBMITTED', actorId: student, actorRole: 'STUDENT' });

      const event = await prisma.outboxEvent.findFirstOrThrow({ where: { aggregateId: review.id } });
      expect(event.type).to.equal('ReviewSubmitted');
      expect(event.payload).to.deep.equal({
        review_id: review.id,
        application_id: row.id,
        student_user_id: student,
        company_id: companyId,
        content: { title: 'ดีมาก', body: 'ได้เรียนรู้งานจริง พี่เลี้ยงใส่ใจ' },
        rating: 4,
        outcome_label: 'PASS',
        submitted_at: review.createdAt.toISOString(),
      });
      expect(JSON.stringify(event.payload)).not.to.include('สมหญิง');
    });

    it('UAT-07: รีวิวหลัง FAIL ได้พร้อมป้าย FAIL (รวมระหว่างโต้แย้ง)', async () => {
      const failed = await seed('EVALUATED_FAIL', {}, 'FAIL');
      await write(failed.id).expect(201);
      const disputed = await seed('FAIL_DISPUTED', {}, 'FAIL');
      await write(disputed.id).expect(201);
      const labels = (await prisma.review.findMany({ where: { studentUserId: student } })).map((r) => r.outcomeLabel);
      expect(labels).to.deep.equal(['FAIL', 'FAIL']);
    });

    it('ป้าย TERMINATED (UAT-20 — รวมใบที่ยุติแล้วบริษัทประเมินต่อ) / NO_EVALUATION (UAT-22) / COMPLETED ใช้ผลประเมินล่าสุด', async () => {
      const t = await seed('TERMINATED', { terminatedBy: 'COMPANY', terminateReason: 'x' });
      const tEval = await seed('EVALUATED_PASS', { terminatedBy: 'STUDENT', terminateReason: 'x' }, 'PASS');
      const n = await seed('NO_EVALUATION');
      const c = await seed('COMPLETED', { academicResult: 'ACADEMIC_PASS' }, 'PASS');
      for (const row of [t, tEval, n, c]) await write(row.id).expect(201);
      const label = async (id: string) => (await prisma.review.findUniqueOrThrow({ where: { applicationId: id } })).outcomeLabel;
      expect([await label(t.id), await label(tEval.id), await label(n.id), await label(c.id)]).to.deep.equal([
        'TERMINATED',
        'TERMINATED',
        'NO_EVALUATION',
        'PASS',
      ]);
    });

    it('ยังไม่ประเมิน/ยังไม่สิ้นสุด ⇒ 422 EVALUATION_NOT_OPEN + REVIEW_NOT_OPEN', async () => {
      for (const status of ['IN_PROGRESS', 'HR_ACCEPTED', 'PENDING', 'WITHDRAWN'] as ApplicationStatus[]) {
        const row = await seed(status);
        const res = await write(row.id).expect(422);
        expect(res.body.error.code, status).to.equal('EVALUATION_NOT_OPEN');
        expect(res.body.error.details[0].issue).to.equal('REVIEW_NOT_OPEN');
      }
    });

    it('เขียนซ้ำ ⇒ 409 ALREADY_REVIEWED; ส่งพร้อมกัน 2 ครั้ง ⇒ สำเร็จ 1', async () => {
      const row = await seed('EVALUATED_PASS', {}, 'PASS');
      await write(row.id).expect(201);
      expect((await write(row.id).expect(409)).body.error.code).to.equal('ALREADY_REVIEWED');

      const other = await seed('EVALUATED_PASS', {}, 'PASS');
      const results = await Promise.all([write(other.id), write(other.id)]);
      expect(results.map((r) => r.status).sort()).to.deep.equal([201, 409]);
      expect(await prisma.review.count({ where: { applicationId: other.id } })).to.equal(1);
    });

    it('ใบของคนอื่น ⇒ 404; Role อื่น ⇒ 403; ไม่มี Token ⇒ 401; ข้อมูลผิด ⇒ 400', async () => {
      const row = await seed('EVALUATED_PASS', {}, 'PASS');
      await write(row.id, {}, asStudent(randomUUID())).expect(404);
      await write(row.id, {}, asHr()).expect(403);
      await http().post(`/v1/applications/${row.id}/review`).send({}).expect(401);
      for (const bad of [{ rating: 0 }, { rating: 6 }, { rating: 4.5 }, { body: '   ' }, { anonymous: 'yes' }, { body: 'x'.repeat(5001) }]) {
        await write(row.id, bad).expect(400);
      }
      expect(await prisma.review.count({ where: { applicationId: row.id } })).to.equal(0);
    });

    it('ไม่มีโปรไฟล์ใน Lifecycle และ Identity ล่ม ⇒ 502 ไม่สร้างรีวิว; มีโปรไฟล์ ⇒ ใช้สาขา/ชั้นปีจากโปรไฟล์', async () => {
      const row = await seed('EVALUATED_PASS', {}, 'PASS');
      identity.unavailable = true;
      await write(row.id).expect(502);
      expect(await prisma.review.count({ where: { applicationId: row.id } })).to.equal(0);

      await prisma.studentProfile.create({ data: { userId: student, major: 'วิศวกรรมซอฟต์แวร์', yearLevel: 3, skills: [] } });
      const res = await write(row.id, { anonymous: true }).expect(201);
      const review = await prisma.review.findUniqueOrThrow({ where: { id: res.body.id } });
      expect(review).to.include({ displayMajor: 'วิศวกรรมซอฟต์แวร์', displayYear: 3, anonymous: true });
    });
  });

  // ------------------------------------------------------------------
  describe('Consumer E10 ReviewModerationResult (UAT-28, UAT-30 ข้อ 2)', () => {
    it('PUBLISH ⇒ PUBLISHED + company_review_stats + E11 (absolute) — ส่งซ้ำด้วย event_id เดิม ⇒ ไม่นับซ้ำ', async () => {
      const a = await submitted({ rating: 4 });
      const eventId = randomUUID();
      expect(await deliver(a.id, 'PUBLISH', { eventId })).to.deep.equal({ kind: 'ack' });
      expect(await deliver(a.id, 'PUBLISH', { eventId })).to.deep.equal({ kind: 'ack' });
      expect(await reviewStatus(a.id)).to.equal('PUBLISHED');
      expect(await stats()).to.include({ reviewCount: 1, ratingSum: 4, entityVersion: 1 });

      const b = await submitted({ rating: 2 });
      await deliver(b.id, 'PUBLISH');
      expect(await stats()).to.include({ reviewCount: 2, ratingSum: 6, entityVersion: 2 });

      const events = await publishedEvents();
      expect(events).to.have.length(2);
      expect(events[1]).to.include({ review_id: b.id, company_id: companyId, rating: 2, company_review_count: 2, company_rating_sum: 6, entity_version: 2 });

      const history = await prisma.statusHistory.findMany({ where: { entity: 'REVIEW', entityId: a.id }, orderBy: { occurredAt: 'asc' } });
      expect(history.map((h) => [h.fromStatus, h.toStatus, h.actorRole])).to.deep.equal([
        [null, 'SUBMITTED', 'STUDENT'],
        ['SUBMITTED', 'PUBLISHED', 'SYSTEM'],
      ]);
    });

    it('HOLD ⇒ HELD (ไม่ตีกลับ ไม่นับสถิติ ไม่เก็บ detail) → ADMIN_PUBLISH ⇒ PUBLISHED + E11', async () => {
      const r = await submitted();
      await deliver(r.id, 'HOLD');
      expect(await reviewStatus(r.id)).to.equal('HELD');
      expect(await stats()).to.equal(null);
      const held = await prisma.statusHistory.findFirstOrThrow({ where: { entityId: r.id, toStatus: 'HELD' } });
      expect(held.reason).to.equal('PERSONAL_CONTACT');

      await deliver(r.id, 'ADMIN_PUBLISH');
      expect(await reviewStatus(r.id)).to.equal('PUBLISHED');
      expect(await stats()).to.include({ reviewCount: 1 });
      const published = await prisma.statusHistory.findFirstOrThrow({ where: { entityId: r.id, toStatus: 'PUBLISHED' } });
      expect(published).to.include({ actorRole: 'PLATFORM_ADMIN', actorId: null });
    });

    it('ADMIN_REMOVE จาก PUBLISHED ⇒ REMOVED + หักสถิติ + E11 ใหม่; จาก HELD/SUBMITTED ⇒ REMOVED ไม่แตะสถิติ', async () => {
      const a = await submitted({ rating: 5 });
      const b = await submitted({ rating: 3 });
      await deliver(a.id, 'PUBLISH');
      await deliver(b.id, 'PUBLISH');
      await deliver(a.id, 'ADMIN_REMOVE');
      expect(await reviewStatus(a.id)).to.equal('REMOVED');
      expect(await stats()).to.include({ reviewCount: 1, ratingSum: 3, entityVersion: 3 });
      const last = (await publishedEvents()).at(-1)!;
      expect(last).to.include({ review_id: a.id, company_review_count: 1, company_rating_sum: 3, entity_version: 3 });

      const c = await submitted();
      await deliver(c.id, 'HOLD');
      await deliver(c.id, 'ADMIN_REMOVE');
      const d = await submitted();
      await deliver(d.id, 'ADMIN_REMOVE');
      expect([await reviewStatus(c.id), await reviewStatus(d.id)]).to.deep.equal(['REMOVED', 'REMOVED']);
      expect(await stats()).to.include({ reviewCount: 1, entityVersion: 3 });
    });

    it('ADMIN_REMOVE ของ PUBLISHED เมื่อไม่มีแถวสถิติ ⇒ ไม่ throw (ไม่ retry/DLQ) ไม่ติดลบ และยังส่ง E11 (PM รีวิว #57)', async () => {
      const r = await submitted({ rating: 4 });
      await deliver(r.id, 'PUBLISH');
      await prisma.companyReviewStats.delete({ where: { companyId } });
      await deliver(r.id, 'ADMIN_REMOVE');
      expect(await reviewStatus(r.id)).to.equal('REMOVED');
      expect(await stats()).to.include({ reviewCount: 0, ratingSum: 0 });
      expect((await publishedEvents()).at(-1)).to.include({ review_id: r.id, company_review_count: 0, company_rating_sum: 0 });
    });

    it('สถานะไม่ตรง ⇒ ข้ามไม่ throw (ack): ADMIN_PUBLISH ของ PUBLISHED, PUBLISH/HOLD ของ HELD/REMOVED, ADMIN_REMOVE ซ้ำ, ไม่พบรีวิว', async () => {
      const r = await submitted();
      await deliver(r.id, 'PUBLISH');
      const before = await stats();
      expect(await deliver(r.id, 'ADMIN_PUBLISH')).to.deep.equal({ kind: 'ack' });
      expect(await deliver(r.id, 'PUBLISH')).to.deep.equal({ kind: 'ack' });
      expect(await deliver(r.id, 'HOLD')).to.deep.equal({ kind: 'ack' });
      expect(await stats()).to.deep.equal(before);

      await deliver(r.id, 'ADMIN_REMOVE');
      expect(await deliver(r.id, 'ADMIN_REMOVE')).to.deep.equal({ kind: 'ack' });
      expect(await deliver(r.id, 'PUBLISH')).to.deep.equal({ kind: 'ack' });
      expect(await reviewStatus(r.id)).to.equal('REMOVED');
      expect(await stats()).to.include({ reviewCount: 0, ratingSum: 0 });

      expect(await deliver(randomUUID(), 'PUBLISH')).to.deep.equal({ kind: 'ack' });
    });

    it('payload ผิดรูป ⇒ dead-letter ทันที (ไม่ retry) และไม่เปลี่ยนข้อมูล', async () => {
      const r = await submitted();
      const base = { review_id: r.id, student_user_id: student, decision: 'PUBLISH', reasons: [], decided_by: 'SYSTEM', decided_at: new Date().toISOString() };
      for (const payload of [
        { ...base, review_id: 'not-a-uuid' },
        { ...base, decision: 'APPROVE' },
        { ...base, decided_by: 'ROBOT' },
        { ...base, decided_at: '2026-11-18T08:00:00.000900Z' },
        { ...base, reasons: 'BLACKLIST' },
      ]) {
        const outcome = await deliver(r.id, 'PUBLISH', { payload });
        expect(outcome).to.include({ kind: 'dead-letter', reason: 'invalid_message' });
      }
      expect(await reviewStatus(r.id)).to.equal('SUBMITTED');
      expect(InvalidMessageError).to.be.a('function');
    });

    it('E10 สองรายการของรีวิวเดียวกันพร้อมกัน (PUBLISH + ADMIN_REMOVE) ⇒ สถิติสอดคล้องกับสถานะสุดท้าย', async () => {
      const r = await submitted({ rating: 5 });
      await Promise.all([deliver(r.id, 'PUBLISH'), deliver(r.id, 'ADMIN_REMOVE')]);
      const status = await reviewStatus(r.id);
      expect(status).to.equal('REMOVED');
      const s = await stats();
      expect(s?.reviewCount ?? 0).to.equal(0);
      expect(s?.ratingSum ?? 0).to.equal(0);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /me/reviews', () => {
    it('เห็นรีวิวของตนทุกสถานะ คนอื่นไม่เห็น', async () => {
      const a = await submitted();
      await deliver(a.id, 'HOLD');
      const res = await http().get('/v1/me/reviews').set('Authorization', asStudent()).expect(200);
      expect(res.body.meta.total).to.equal(1);
      expect(res.body.data[0]).to.include({ id: a.id, status: 'HELD' });
      const other = await http().get('/v1/me/reviews').set('Authorization', asStudent(randomUUID())).expect(200);
      expect(other.body.data).to.have.length(0);
      await http().get('/v1/me/reviews').set('Authorization', asHr()).expect(403);
    });
  });

  // ------------------------------------------------------------------
  describe('POST /hr/reviews/{id}/reply', () => {
    const reply = (id: string, body: Record<string, unknown> = { body: 'ขอบคุณสำหรับคำติชม' }, token = asHr()) =>
      http().post(`/v1/hr/reviews/${id}/reply`).set('Authorization', token).send(body);

    it('ตอบรีวิว PUBLISHED ของบริษัทตน 1 ครั้ง (ซ้ำ ⇒ 409 ALREADY_REPLIED)', async () => {
      const r = await submitted();
      await deliver(r.id, 'PUBLISH');
      const res = await reply(r.id).expect(201);
      expect(res.body).to.include({ review_id: r.id, body: 'ขอบคุณสำหรับคำติชม' });
      expect((await reply(r.id).expect(409)).body.error.code).to.equal('ALREADY_REPLIED');
      const row = await prisma.reviewReply.findUniqueOrThrow({ where: { reviewId: r.id } });
      expect(row).to.include({ companyId, repliedBy: hrUser });
    });

    it('บริษัทอื่น ⇒ 403; รีวิวที่ยังไม่เผยแพร่/ไม่มี ⇒ 404; body ว่าง ⇒ 400; Role อื่น ⇒ 403', async () => {
      const r = await submitted();
      await reply(r.id).expect(404);
      await deliver(r.id, 'PUBLISH');
      expect((await reply(r.id, undefined, asHr(randomUUID())).expect(403)).body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
      await reply(r.id, { body: '  ' }).expect(400);
      await reply(randomUUID()).expect(404);
      await reply(r.id, undefined, asStudent()).expect(403);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /companies/{company_id}/reviews — Public (api-contract §3, §7.6)', () => {
    /** ผู้เยี่ยมชม: ไม่มี Authorization เลย */
    const list = (id = companyId) => http().get(`/v1/companies/${id}/reviews`).expect(200);
    const ALLOWED = ['id', 'rating', 'title', 'body', 'outcome_label', 'reviewer_name', 'display_major', 'display_year', 'reply', 'published_at'];

    it('เฉพาะ PUBLISHED (SUBMITTED/HELD/REMOVED ไม่ปรากฏ) + outcome_label + คำตอบของบริษัท', async () => {
      const pub = await submitted({ rating: 5 });
      await deliver(pub.id, 'PUBLISH');
      const held = await submitted();
      await deliver(held.id, 'HOLD');
      const removed = await submitted();
      await deliver(removed.id, 'PUBLISH');
      await deliver(removed.id, 'ADMIN_REMOVE');
      await submitted();
      await http().post(`/v1/hr/reviews/${pub.id}/reply`).set('Authorization', asHr()).send({ body: 'ขอบคุณครับ' }).expect(201);

      const res = await list();
      expect(res.body.meta.total).to.equal(1);
      expect(res.body.data[0]).to.include({ id: pub.id, rating: 5, outcome_label: 'PASS', reviewer_name: 'สมหญิง รักงาน' });
      expect(res.body.data[0].reply.body).to.equal('ขอบคุณครับ');
    });

    it('anonymous ⇒ display_major/display_year แทนชื่อ และทุกรายการไม่มี student_user_id/application_id/id ของผู้ตอบ', async () => {
      const anon = await submitted({ anonymous: true });
      const named = await submitted({ anonymous: false });
      await deliver(anon.id, 'PUBLISH');
      await deliver(named.id, 'PUBLISH');
      await http().post(`/v1/hr/reviews/${anon.id}/reply`).set('Authorization', asHr()).send({ body: 'รับทราบ' }).expect(201);

      const res = await list();
      const byId = new Map<string, Record<string, unknown>>(res.body.data.map((r: { id: string }) => [r.id, r]));
      const a = byId.get(anon.id)!;
      expect(a).to.include({ display_major: 'วิทยาการคอมพิวเตอร์', display_year: 4 });
      expect(a).not.to.have.property('reviewer_name');
      expect(byId.get(named.id)).to.include({ reviewer_name: 'สมหญิง รักงาน' });

      const raw = JSON.stringify(res.body);
      expect(raw).not.to.include(student);
      expect(raw).not.to.include(hrUser);
      for (const item of res.body.data) {
        for (const key of Object.keys(item)) expect(ALLOWED, key).to.include(key);
        if (item.reply) expect(Object.keys(item.reply).sort()).to.deep.equal(['body', 'created_at']);
      }
    });

    it('ชื่อดึงจาก Identity ครั้งเดียวต่อหน้า; Identity ล่ม/บัญชีถูกลบ ⇒ แสดงแบบไม่ระบุชื่อแทน (ไม่ 502)', async () => {
      const a = await submitted();
      const b = await submitted();
      await deliver(a.id, 'PUBLISH');
      await deliver(b.id, 'PUBLISH');
      identity.nameCalls = [];
      await list();
      expect(identity.nameCalls).to.have.length(1);

      identity.unavailable = true;
      const res = await list();
      for (const item of res.body.data) {
        expect(item).not.to.have.property('reviewer_name');
        expect(item).to.include({ display_major: 'วิทยาการคอมพิวเตอร์', display_year: 4 });
      }
    });

    it('ไม่มี Token ⇒ 200 + Cache-Control: public, max-age=60; Pagination มาตรฐาน', async () => {
      for (let i = 0; i < 3; i += 1) {
        const r = await submitted();
        await deliver(r.id, 'PUBLISH');
      }
      const res = await list();
      expect(res.headers['cache-control']).to.equal('public, max-age=60');
      const page = await http().get(`/v1/companies/${companyId}/reviews?page=2&page_size=2`).expect(200);
      expect(page.body.meta).to.deep.equal({ page: 2, page_size: 2, total: 3 });
      expect(page.body.data).to.have.length(1);
      await http().get(`/v1/companies/${companyId}/reviews?page_size=101`).expect(400);
      await http().get('/v1/companies/not-a-uuid/reviews').expect(400);
    });

    it('Response เหมือนกันทุกผู้เรียก (ผู้เยี่ยมชม/นักศึกษาเจ้าของ/HR/Admin) — Token เสียก็ไม่ถูกปฏิเสธ', async () => {
      const anon = await submitted({ anonymous: true });
      const named = await submitted();
      await deliver(anon.id, 'PUBLISH');
      await deliver(named.id, 'PUBLISH');
      const url = `/v1/companies/${companyId}/reviews`;
      const guest = (await list()).body;
      for (const token of [asStudent(), asHr(), bearer({ role: 'PLATFORM_ADMIN' }), 'Bearer broken.token']) {
        const res = await http().get(url).set('Authorization', token).expect(200);
        expect(res.body, token.slice(0, 20)).to.deep.equal(guest);
      }
    });
  });
});
