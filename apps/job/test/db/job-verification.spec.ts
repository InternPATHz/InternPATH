import { randomUUID } from 'node:crypto';
import {
  OutboxWriter,
  processDelivery,
  type EventConsumer,
  type Subscription,
} from '@internpath/common';
import type { JobStatus, JobVerifiedPayload } from '@internpath/contracts';
import { Logger } from '@nestjs/common';
import { expect } from 'chai';
import sinon from 'sinon';
import { JobVerifiedConsumer } from '../../src/events/consumers/job-verified.consumer';
import type { Tx } from '../../src/prisma/types';
import { JobStatusTransitionService } from '../../src/status/job-status-transition.service';
import { JobVerificationService } from '../../src/status/job-verification.service';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { jobVerified, NOW, seedJob } from '../support/job-events';

const CASES: Array<{
  decision: JobVerifiedPayload['decision'];
  from: JobStatus;
  to: JobStatus;
  effect?: string;
}> = [
  { decision: 'APPROVE', from: 'VERIFYING', to: 'PUBLISHED', effect: 'UNFREEZE' },
  { decision: 'PENDING_REVIEW', from: 'VERIFYING', to: 'PENDING_REVIEW', effect: 'FREEZE' },
  { decision: 'AUTO_REJECT', from: 'VERIFYING', to: 'AUTO_REJECTED' },
  { decision: 'APPEAL_ACCEPTED', from: 'AUTO_REJECTED', to: 'PENDING_REVIEW', effect: 'FREEZE' },
  { decision: 'ADMIN_APPROVE', from: 'PENDING_REVIEW', to: 'PUBLISHED', effect: 'UNFREEZE' },
  { decision: 'ADMIN_REJECT', from: 'PENDING_REVIEW', to: 'ADMIN_REJECTED' },
];

describe('E02 screening/admin decisions (PostgreSQL + shared EventConsumer transactions)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let subscription: Subscription<Tx>;
  let sandbox: sinon.SinonSandbox;
  let warn: sinon.SinonStub;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
  });
  after(async () => db?.drop());
  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    sandbox.useFakeTimers({ now: NOW, toFake: ['Date'] });
    warn = sandbox.stub(Logger.prototype, 'warn');
    const service = new JobVerificationService(new JobStatusTransitionService(new OutboxWriter()));
    const consumer = {
      subscribe: async (sub: Subscription<Tx>) => {
        subscription = sub;
      },
    } as EventConsumer<Tx>;
    await new JobVerifiedConsumer(consumer, service).onModuleInit();
  });
  afterEach(() => sandbox.restore());

  const deliver = (
    env: ReturnType<typeof jobVerified>,
    transform?: (tx: Tx) => Tx,
    retryCount = 0,
  ) =>
    processDelivery<Tx>({
      raw: Buffer.from(JSON.stringify(env)),
      queue: 'job.JobVerified',
      sub: subscription,
      retryCount,
      maxRetries: 3,
      runInTransaction: (fn) => db.prisma.$transaction((tx) => fn(transform ? transform(tx) : tx)),
    });
  const writes = async (id: string) => ({
    history: await db.prisma.statusHistory.findMany({ where: { entityId: id } }),
    outbox: await db.prisma.outboxEvent.findMany({ where: { aggregateId: id } }),
  });

  for (const c of CASES) {
    it(`${c.decision}: ${c.from} -> ${c.to}, one increment/history/E03; stale distinct repeat is a no-op`, async () => {
      const before = await seedJob(db.prisma, c.from);
      const env = jobVerified(before.id, before.currentSubmissionId!, c.decision);
      // Input reasons may contain sensitive matched content; do not forward them to E03 or logs.
      env.payload.reasons = [
        { code: 'TEST', detail: 'Private decision detail', matched_text: 'Private match' },
      ];
      expect(await deliver(env)).to.deep.equal({ kind: 'ack' });
      const after = await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } });
      expect(after).to.include({ status: c.to, version: 5, entityVersion: 11 });
      const rows = await writes(before.id);
      expect(rows.history).to.have.length(1);
      expect(rows.outbox).to.have.length(1);
      expect(rows.history[0]).to.include({
        fromStatus: c.from,
        toStatus: c.to,
        reason: c.decision,
        correlationId: env.correlation_id,
      });
      expect(rows.outbox[0].payload).to.deep.equal({
        job_id: before.id,
        company_id: before.companyId,
        from_status: c.from,
        to_status: c.to,
        entity_version: 11,
        changed_at: NOW.toISOString(),
        ...(c.effect ? { application_effect: c.effect } : {}),
      });
      expect(rows.outbox[0].correlationId).to.equal(env.correlation_id);
      expect(await deliver({ ...env, event_id: randomUUID() })).to.deep.equal({ kind: 'ack' });
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
        after,
      );
      expect(await writes(before.id)).to.deep.equal(rows);
      expect(warn.calledOnce).to.equal(true);
    });

    it(`${c.decision}: mismatched current_submission_id is ignored without transition writes`, async () => {
      const before = await seedJob(db.prisma, c.from);
      const env = jobVerified(before.id, randomUUID(), c.decision);
      expect(await deliver(env)).to.deep.equal({ kind: 'ack' });
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
        before,
      );
      expect(await writes(before.id)).to.deep.equal({ history: [], outbox: [] });
      expect(warn.calledOnce).to.equal(true);
      expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(
        1,
      );
    });

    it(`${c.decision}: mismatched status is ignored without transition writes`, async () => {
      const before = await seedJob(db.prisma, 'DRAFT');
      expect(
        await deliver(jobVerified(before.id, before.currentSubmissionId!, c.decision)),
      ).to.deep.equal({ kind: 'ack' });
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
        before,
      );
      expect(await writes(before.id)).to.deep.equal({ history: [], outbox: [] });
      expect(warn.calledOnce).to.equal(true);
    });
  }

  it('concurrent duplicate event IDs produce one transition and one processed marker', async () => {
    const before = await seedJob(db.prisma);
    const env = jobVerified(before.id, before.currentSubmissionId!);
    const outcomes = await Promise.all(Array.from({ length: 8 }, () => deliver(env)));
    expect(outcomes.every((o) => o.kind === 'ack')).to.equal(true);
    expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(1);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.include({
      status: 'PUBLISHED',
      entityVersion: 11,
      version: 5,
    });
    const rows = await writes(before.id);
    expect(rows.history).to.have.length(1);
    expect(rows.outbox).to.have.length(1);
  });

  it('conflicting APPROVE/AUTO_REJECT decisions commit exactly one transition for each of 40 Jobs', async () => {
    const jobs = await Promise.all(Array.from({ length: 40 }, () => seedJob(db.prisma)));
    const outcomes = await Promise.all(
      jobs.flatMap((job) => [
        deliver(jobVerified(job.id, job.currentSubmissionId!, 'APPROVE')),
        deliver(jobVerified(job.id, job.currentSubmissionId!, 'AUTO_REJECT')),
      ]),
    );
    expect(outcomes.every((o) => o.kind === 'ack')).to.equal(true);
    const ids = jobs.map((j) => j.id);
    const rows = await db.prisma.job.findMany({ where: { id: { in: ids } } });
    expect(rows).to.have.length(40);
    expect(
      rows.every(
        (r) =>
          r.entityVersion === 11 &&
          r.version === 5 &&
          ['PUBLISHED', 'AUTO_REJECTED'].includes(r.status),
      ),
    ).to.equal(true);
    expect(await db.prisma.statusHistory.count({ where: { entityId: { in: ids } } })).to.equal(40);
    expect(await db.prisma.outboxEvent.count({ where: { aggregateId: { in: ids } } })).to.equal(40);
  });

  it('a submission replaced after the actual read is still rejected by the conditional update', async () => {
    const before = await seedJob(db.prisma);
    let read = false;
    let readReady!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      readReady = resolve;
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transform = (tx: Tx): Tx =>
      new Proxy(tx, {
        get(target, key, receiver) {
          if (key !== 'job') return Reflect.get(target, key, receiver);
          return new Proxy(target.job, {
            get(delegate, method, delegateReceiver) {
              if (method !== 'findUnique') return Reflect.get(delegate, method, delegateReceiver);
              return async (args: Parameters<Tx['job']['findUnique']>[0]) => {
                const row = await delegate.findUnique(args);
                if (!read) {
                  read = true;
                  readReady();
                  await gate;
                }
                return row;
              };
            },
          });
        },
      });
    const result = deliver(jobVerified(before.id, before.currentSubmissionId!), transform);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      // Native timers still advance while only Date is faked for transition timestamps.
      await Promise.race([
        firstRead,
        new Promise<void>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error('Expected Job read did not start')), 5000);
        }),
      ]);
      await db.prisma.job.update({
        where: { id: before.id },
        data: { currentSubmissionId: randomUUID(), version: { increment: 1 } },
      });
    } finally {
      clearTimeout(timeout);
      release();
    }
    expect(await result).to.deep.equal({ kind: 'ack' });
    expect(await writes(before.id)).to.deep.equal({ history: [], outbox: [] });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.include({
      status: 'VERIFYING',
      entityVersion: 10,
    });
  });

  for (const decision of ['RESTORE', 'REMOVE', 'UNKNOWN_DECISION'] as const) {
    it(`${decision}: unimplemented/unsupported decisions fail explicitly and retain no processed marker`, async () => {
      const before = await seedJob(db.prisma, 'SUSPENDED', { suspendedFromStatus: 'PUBLISHED' });
      const env = jobVerified(before.id, before.currentSubmissionId!);
      env.payload.decision = decision as JobVerifiedPayload['decision'];
      expect(await deliver(env)).to.deep.equal({ kind: 'retry', nextCount: 1 });
      expect(await deliver(env, undefined, 3)).to.include({
        kind: 'dead-letter',
        reason: 'retries_exhausted',
      });
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
        before,
      );
      expect(await writes(before.id)).to.deep.equal({ history: [], outbox: [] });
      expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(
        0,
      );
    });
  }

  it('a missing Job is a warned no-op', async () => {
    const env = jobVerified(randomUUID(), randomUUID());
    expect(await deliver(env)).to.deep.equal({ kind: 'ack' });
    expect(warn.calledOnce).to.equal(true);
  });

  it('a missing current submission cannot match a malformed null submission ID', async () => {
    const before = await seedJob(db.prisma, 'VERIFYING', { currentSubmissionId: null });
    const env = jobVerified(before.id, randomUUID());
    env.payload.submission_id = null as unknown as string;
    expect(await deliver(env)).to.deep.equal({ kind: 'ack' });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
      before,
    );
    expect(await writes(before.id)).to.deep.equal({ history: [], outbox: [] });
    expect(warn.calledOnce).to.equal(true);
  });
});
