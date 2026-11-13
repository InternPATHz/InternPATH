import { randomUUID } from 'node:crypto';
import type { EventEnvelope, JobSubmittedPayload } from '@internpath/contracts';
import { Logger } from '@nestjs/common';
import { expect } from 'chai';
import sinon from 'sinon';
import { EvaluationModule } from '../../src/evaluation/evaluation.module';
import { EvaluationService } from '../../src/evaluation/evaluation.service';
import { RulesRepository } from '../../src/rules/rules.repository';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';

const LONG = 'พัฒนาเว็บแอปพลิเคชันร่วมกับทีมวิศวกรอาวุโสและเรียนรู้กระบวนการทำงานจริงของบริษัท '.repeat(2);

function submitted(over: Partial<JobSubmittedPayload> = {}, content: Partial<JobSubmittedPayload['content']> = {}): JobSubmittedPayload {
  return {
    job_id: randomUUID(),
    company_id: randomUUID(),
    submission_id: randomUUID(),
    submission_kind: 'NEW',
    content: {
      job_title: 'นักศึกษาฝึกงานด้านพัฒนาซอฟต์แวร์',
      description: LONG,
      responsibilities: 'เขียนโค้ดและทดสอบ',
      qualifications: 'กำลังศึกษาด้านคอมพิวเตอร์',
      allowance_text: 'เบี้ยเลี้ยงรายเดือน',
      location: 'กรุงเทพฯ',
      ...content,
    },
    work_mode: 'HYBRID',
    hours_per_week: 35,
    allowance: { type: 'AMOUNT', amount_thb: 5000 },
    company_flag_under_review: false,
    fast_track: false,
    submitted_at: new Date().toISOString(),
    ...over,
  };
}

const envelope = (payload: JobSubmittedPayload): EventEnvelope<'JobSubmitted', JobSubmittedPayload> => ({
  event_id: randomUUID(),
  type: 'JobSubmitted',
  version: 1,
  occurred_at: new Date().toISOString(),
  correlation_id: randomUUID(),
  producer: 'job',
  payload,
});

describe('EvaluationService.handleJobSubmitted (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: EvaluationService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [EvaluationModule], db });
    svc = t.app.get(EvaluationService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });
  afterEach(async () => {
    sinon.restore();
    await t.prisma.$executeRawUnsafe('TRUNCATE evaluations, queue_items, outbox_events');
  });

  const handle = (env: EventEnvelope<'JobSubmitted', JobSubmittedPayload>) =>
    t.prisma.$transaction((tx) => svc.handleJobSubmitted(env, tx));
  const outboxRows = () => t.prisma.outboxEvent.findMany({ orderBy: { createdAt: 'asc' } });

  it('ประกาศสะอาด → evaluations 1 แถว (APPROVE, LOW), outbox JobVerified APPROVE, ไม่มีรายการคิว', async () => {
    const p = submitted({ fast_track: true });
    const env = envelope(p);
    await handle(env);

    const evals = await t.prisma.evaluation.findMany();
    expect(evals).to.have.length(1);
    expect(evals[0]).to.include({
      jobId: p.job_id,
      companyId: p.company_id,
      submissionId: p.submission_id,
      submissionKind: 'NEW',
      riskScore: 0,
      riskLevel: 'LOW',
      decision: 'APPROVE',
      negatedOnly: false,
      companyFlagUnderReview: false,
      fastTrack: true,
    });
    expect(evals[0].submittedAt.toISOString()).to.equal(p.submitted_at);

    const out = await outboxRows();
    expect(out).to.have.length(1);
    expect(out[0]).to.include({ type: 'JobVerified', aggregateId: p.job_id, correlationId: env.correlation_id });
    expect(out[0].payload).to.deep.include({
      job_id: p.job_id,
      submission_id: p.submission_id,
      decision: 'APPROVE',
      risk_score: 0,
      risk_level: 'LOW',
      is_appeal: false,
      decided_by: 'SYSTEM',
    });
    expect((out[0].payload as any).reasons).to.deep.equal([]);
    expect(new Date((out[0].payload as any).decided_at).getTime()).to.be.greaterThan(Date.now() - 60_000);
    expect(await t.prisma.queueItem.count()).to.equal(0);
  });

  it('เก็บ content ที่ผ่าน normalizeText (ไม่มีอักขระความกว้างศูนย์)', async () => {
    await handle(envelope(submitted({}, { description: LONG + ' ทดสอบ​คำ' })));
    const e = (await t.prisma.evaluation.findFirst())!;
    expect((e.content as any).description).to.include('ทดสอบคำ');
    expect((e.content as any).description).to.not.include('​');
  });

  it('ประกาศมีเบอร์โทร → PENDING_REVIEW, คิว JOB_REVIEW (MEDIUM, NORMAL, due_at +48 ชม.), status_history 1 แถว, outbox PENDING_REVIEW', async () => {
    const p = submitted({}, { description: LONG + ' โทร 081-234-5678' });
    await handle(envelope(p));

    const items = await t.prisma.queueItem.findMany();
    expect(items).to.have.length(1);
    expect(items[0]).to.include({
      type: 'JOB_REVIEW',
      targetType: 'job',
      targetId: p.job_id,
      companyId: p.company_id,
      submissionId: p.submission_id,
      priority: 'NORMAL',
      riskLevel: 'MEDIUM',
      isAppeal: false,
      origin: 'EVALUATION',
      status: 'OPEN',
    });
    expect(items[0].dueAt.getTime() - items[0].createdAt.getTime()).to.equal(48 * 3600_000);

    const hist = await t.prisma.statusHistory.findMany({ where: { entityId: items[0].id } });
    expect(hist).to.have.length(1);
    expect(hist[0]).to.include({ entity: 'QUEUE_ITEM', fromStatus: null, toStatus: 'OPEN', actorRole: 'SYSTEM', actorId: null });

    const out = await outboxRows();
    expect(out).to.have.length(1);
    expect((out[0].payload as any).decision).to.equal('PENDING_REVIEW');
    expect((out[0].payload as any).reasons.map((r: any) => r.code)).to.include('CONTACT_IN_TEXT');
  });

  it('fast_track=true → priority FAST_TRACK, due_at +12 ชม.', async () => {
    await handle(envelope(submitted({ fast_track: true }, { description: LONG + ' โทร 081-234-5678' })));
    const item = (await t.prisma.queueItem.findFirst())!;
    expect(item.priority).to.equal('FAST_TRACK');
    expect(item.dueAt.getTime() - item.createdAt.getTime()).to.equal(12 * 3600_000);
  });

  it('ธง UNDER_REVIEW + คะแนนต่ำ → PENDING_REVIEW เข้าคิว (LOW)', async () => {
    await handle(envelope(submitted({ company_flag_under_review: true })));
    const item = (await t.prisma.queueItem.findFirst())!;
    expect(item.riskLevel).to.equal('LOW');
    expect((await outboxRows())[0].payload).to.deep.include({ decision: 'PENDING_REVIEW', risk_level: 'LOW' });
  });

  it('คำต้องห้าม → AUTO_REJECT, ไม่มีรายการคิว, outbox มี reasons ที่มี matched_text', async () => {
    await handle(envelope(submitted({}, { description: LONG + ' ต้องจ่ายค่ามัดจำ' })));
    expect(await t.prisma.queueItem.count()).to.equal(0);
    const payload = (await outboxRows())[0].payload as any;
    expect(payload).to.deep.include({ decision: 'AUTO_REJECT', risk_level: 'HIGH' });
    expect(payload.risk_score).to.be.at.least(70);
    expect(payload.reasons.find((r: any) => r.code === 'BLACKLIST_HARD').matched_text).to.equal('ค่ามัดจำ');
  });

  it('ส่ง E01 submission_id เดิมซ้ำ (คนละ event_id) → evaluations และ outbox ยังอย่างละแถว', async () => {
    const p = submitted({}, { description: LONG + ' โทร 081-234-5678' });
    await handle(envelope(p));
    await handle(envelope(p));
    expect(await t.prisma.evaluation.count()).to.equal(1);
    expect(await t.prisma.outboxEvent.count()).to.equal(1);
    expect(await t.prisma.queueItem.count()).to.equal(1);
  });

  it('เรียกพร้อมกัน 2 ครั้ง (Promise.all) ด้วย submission_id เดียวกัน → ไม่เกิน 1 แถว/1 outbox/1 คิว และไม่ reject', async () => {
    const p = submitted({}, { description: LONG + ' โทร 081-234-5678' });
    const results = await Promise.allSettled([handle(envelope(p)), handle(envelope(p))]);
    expect(results.map((r) => (r.status === 'rejected' ? `rejected: ${String(r.reason)}` : 'fulfilled'))).to.deep.equal([
      'fulfilled',
      'fulfilled',
    ]);
    expect(await t.prisma.evaluation.count()).to.equal(1);
    expect(await t.prisma.outboxEvent.count()).to.equal(1);
    expect(await t.prisma.queueItem.count()).to.equal(1);
  });

  it('ตัวตัดสินขัดข้อง (โหลดกฎไม่ได้ / กฎเสีย) → handler reject, rollback ทั้งก้อน, ไม่มี evaluations และไม่มี outbox', async () => {
    const repo = t.app.get(RulesRepository);
    const stub = sinon.stub(repo, 'load');

    stub.rejects(new Error('db hiccup'));
    let err: Error | undefined;
    try {
      await handle(envelope(submitted()));
    } catch (e) {
      err = e as Error;
    }
    expect(err?.message).to.equal('db hiccup');

    stub.resolves({ blacklist: null, negationCues: null, riskRules: null } as never); // evaluateJob โยน TypeError
    err = undefined;
    try {
      await handle(envelope(submitted()));
    } catch (e) {
      err = e as Error;
    }
    expect(err).to.be.instanceOf(Error);

    expect(await t.prisma.evaluation.count()).to.equal(0);
    expect(await t.prisma.outboxEvent.count()).to.equal(0);
    expect(await t.prisma.queueItem.count()).to.equal(0);
  });

  it('ฟิลด์ที่ไม่รู้จักใน payload/content ไม่ทำให้ล้ม', async () => {
    const p = { ...submitted(), future_field: { a: 1 } } as JobSubmittedPayload;
    (p.content as any).extra = 'x';
    await handle(envelope(p));
    expect(await t.prisma.evaluation.count()).to.equal(1);
  });

  it('ไม่มี log ใดที่มีเนื้อหาประกาศหรือช่องทางติดต่อ', async () => {
    const spies = (['log', 'warn', 'error', 'debug', 'verbose'] as const).map((m) => sinon.spy(Logger.prototype, m));
    const secret = 'ความลับของประกาศ-xyz';
    await handle(envelope(submitted({}, { description: LONG + ` ${secret} โทร 081-234-5678`, contact_notes: 'line id: secretid123' })));
    const logged = spies.flatMap((s) => s.getCalls().map((c) => c.args.map(String).join(' '))).join('\n');
    expect(logged).to.not.include(secret);
    expect(logged).to.not.include('081-234-5678');
    expect(logged).to.not.include('secretid123');
  });
});
