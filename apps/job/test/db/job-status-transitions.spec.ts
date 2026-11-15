import { randomUUID } from 'node:crypto';
import { OutboxWriter, processDelivery } from '@internpath/common';
import type { EventEnvelope, JobStatus, JobStatusChangedPayload } from '@internpath/contracts';
import { expect } from 'chai';
import sinon from 'sinon';
import { JobStatusTransitionService } from '../../src/status/job-status-transition.service';
import type { Tx } from '../../src/prisma/types';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { jobVerified, NOW, seedJob } from '../support/job-events';

const TIMESTAMPS = {
  publishedAt: new Date('2026-11-14T10:00:00.000Z'),
  verifyingSince: new Date('2026-11-15T09:00:00.000Z'),
};

describe('Job atomic status/history/outbox foundation (PostgreSQL)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let writer: OutboxWriter;
  let transitions: JobStatusTransitionService;
  let sandbox: sinon.SinonSandbox;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
  });
  after(async () => db?.drop());
  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.useFakeTimers({ now: NOW, toFake: ['Date'] });
    writer = new OutboxWriter();
    transitions = new JobStatusTransitionService(writer);
  });
  afterEach(() => sandbox.restore());

  const counts = async (jobId: string, eventId: string) => ({
    history: await db.prisma.statusHistory.count({ where: { entityId: jobId } }),
    outbox: await db.prisma.outboxEvent.count({ where: { aggregateId: jobId } }),
    marker: await db.prisma.processedEvent.count({ where: { eventId } }),
  });
  const deliver = (env: EventEnvelope, handler: (tx: Tx) => Promise<void>) =>
    processDelivery<Tx>({
      raw: Buffer.from(JSON.stringify(env)),
      retryCount: 0,
      maxRetries: 3,
      queue: 'job.JobVerified',
      sub: { type: env.type, producer: 'verification', handler: (_env, tx) => handler(tx) },
      runInTransaction: (fn) => db.prisma.$transaction(fn),
    });

  it('commits the status, one version increment, history, typed E03 and processed marker together', async () => {
    const before = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
    const env = jobVerified(before.id, before.currentSubmissionId!);
    // The supplied transaction timestamp must win over the current wall clock.
    sandbox.clock.tick(1000);
    const result = await deliver(env, async (tx) => {
      expect(
        await transitions.change(
          tx,
          before,
          {
            to: 'PUBLISHED',
            correlationId: env.correlation_id,
            historyReason: 'APPROVE',
            actorRole: 'SYSTEM',
            applicationEffect: 'UNFREEZE',
          },
          NOW,
        ),
      ).to.equal(true);
    });
    expect(result).to.deep.equal({ kind: 'ack' });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.include({
      status: 'PUBLISHED',
      entityVersion: 11,
      version: 5,
    });
    const after = await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.publishedAt).to.deep.equal(NOW);
    expect(after.verifyingSince).to.equal(null);
    expect(await counts(before.id, env.event_id)).to.deep.equal({
      history: 1,
      outbox: 1,
      marker: 1,
    });
    const history = await db.prisma.statusHistory.findFirstOrThrow({
      where: { entityId: before.id },
    });
    expect(history).to.include({
      entity: 'JOB',
      fromStatus: 'VERIFYING',
      toStatus: 'PUBLISHED',
      actorId: null,
      actorRole: 'SYSTEM',
      reason: 'APPROVE',
      correlationId: env.correlation_id,
    });
    expect(history.occurredAt.toISOString()).to.equal(NOW.toISOString());
    const outbox = await db.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: before.id },
    });
    const payload: JobStatusChangedPayload = {
      job_id: before.id,
      company_id: before.companyId,
      from_status: 'VERIFYING',
      to_status: 'PUBLISHED',
      entity_version: 11,
      changed_at: NOW.toISOString(),
      application_effect: 'UNFREEZE',
    };
    expect(outbox).to.include({
      type: 'JobStatusChanged',
      version: 1,
      correlationId: env.correlation_id,
      publishedAt: null,
    });
    expect(outbox.payload).to.deep.equal(payload);
  });

  for (const stage of ['history', 'outbox', 'after-outbox'] as const) {
    it(`rolls back status, history, outbox and processed marker when ${stage} fails`, async () => {
      const before = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
      const env = jobVerified(before.id, before.currentSubmissionId!);
      if (stage === 'outbox')
        sandbox.stub(writer, 'add').rejects(new Error('Intentional outbox failure'));
      const result = await deliver(env, async (tx) => {
        const client =
          stage === 'history'
            ? new Proxy(tx, {
                get(target, key, receiver) {
                  if (key === 'statusHistory')
                    return {
                      create: async () => {
                        throw new Error('Intentional history failure');
                      },
                    };
                  return Reflect.get(target, key, receiver);
                },
              })
            : tx;
        await transitions.change(
          client,
          before,
          {
            to: 'PUBLISHED',
            correlationId: env.correlation_id,
            historyReason: 'APPROVE',
            actorRole: 'SYSTEM',
          },
          new Date(),
        );
        if (stage === 'after-outbox') throw new Error('Intentional failure after every write');
      });
      expect(result).to.deep.equal({ kind: 'retry', nextCount: 1 });
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
        before,
      );
      expect(await counts(before.id, env.event_id)).to.deep.equal({
        history: 0,
        outbox: 0,
        marker: 0,
      });
    });
  }

  it('does not lose a current decision when an unrelated edit changes optimistic version', async () => {
    const before = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
    const env = jobVerified(before.id, before.currentSubmissionId!);
    await db.prisma.job.update({
      where: { id: before.id },
      data: { quota: 6, version: { increment: 1 } },
    });
    const result = await deliver(env, async (tx) => {
      await transitions.change(
        tx,
        before,
        {
          to: 'PUBLISHED',
          correlationId: env.correlation_id,
          historyReason: 'APPROVE',
          actorRole: 'SYSTEM',
        },
        new Date(),
      );
    });
    expect(result).to.deep.equal({ kind: 'retry', nextCount: 1 });
    const unchanged = await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } });
    expect(unchanged.publishedAt).to.deep.equal(before.publishedAt);
    expect(unchanged.verifyingSince).to.deep.equal(before.verifyingSince);
    expect(await counts(before.id, env.event_id)).to.deep.equal({
      history: 0,
      outbox: 0,
      marker: 0,
    });
    expect(
      await deliver(env, async (tx) => {
        const fresh = await tx.job.findUniqueOrThrow({ where: { id: before.id } });
        await transitions.change(
          tx,
          fresh,
          {
            to: 'PUBLISHED',
            correlationId: env.correlation_id,
            historyReason: 'APPROVE',
            actorRole: 'SYSTEM',
          },
          new Date(),
        );
      }),
    ).to.deep.equal({ kind: 'ack' });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.include({
      quota: 6,
      status: 'PUBLISHED',
      version: 6,
      entityVersion: 11,
    });
    const after = await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.publishedAt).to.deep.equal(NOW);
    expect(after.verifyingSince).to.equal(null);
  });

  it('stale status/submission observations cannot write history, outbox or another increment', async () => {
    const before = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
    await db.prisma.job.update({
      where: { id: before.id },
      data: { currentSubmissionId: randomUUID(), version: { increment: 1 } },
    });
    const env = jobVerified(before.id, before.currentSubmissionId!);
    expect(
      await deliver(env, async (tx) => {
        expect(
          await transitions.change(
            tx,
            before,
            {
              to: 'PUBLISHED',
              correlationId: env.correlation_id,
              historyReason: 'APPROVE',
              actorRole: 'SYSTEM',
            },
            new Date(),
          ),
        ).to.equal(false);
      }),
    ).to.deep.equal({ kind: 'ack' });
    expect(await counts(before.id, env.event_id)).to.deep.equal({
      history: 0,
      outbox: 0,
      marker: 1,
    });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.include({
      status: 'VERIFYING',
      entityVersion: 10,
    });
    const after = await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } });
    expect(after.publishedAt).to.deep.equal(before.publishedAt);
    expect(after.verifyingSince).to.deep.equal(before.verifyingSince);
  });

  for (const [from, to] of [
    ['SUSPENDED', 'PUBLISHED'],
    ['PUBLISHED', 'CLOSED'],
  ] as const satisfies ReadonlyArray<readonly [JobStatus, JobStatus]>) {
    it(`${from} -> ${to} preserves publication and verification timestamps`, async () => {
      // Exercise the generic helper only; no RESTORE consumer path is registered.
      const before = await seedJob(db.prisma, from, TIMESTAMPS);
      const env = jobVerified(before.id, before.currentSubmissionId!);
      expect(
        await deliver(env, async (tx) => {
          expect(
            await transitions.change(
              tx,
              before,
              {
                to,
                correlationId: env.correlation_id,
                historyReason: 'Timestamp preservation regression',
                actorRole: 'SYSTEM',
              },
              NOW,
            ),
          ).to.equal(true);
        }),
      ).to.deep.equal({ kind: 'ack' });
      const after = await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } });
      expect(after.status).to.equal(to);
      expect(after.publishedAt).to.deep.equal(before.publishedAt);
      expect(after.verifyingSince).to.deep.equal(before.verifyingSince);
    });
  }

  it('a no-op transition preserves all timestamps without history or outbox writes', async () => {
    const before = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
    const env = jobVerified(before.id, before.currentSubmissionId!);
    expect(
      await deliver(env, async (tx) => {
        expect(
          await transitions.change(
            tx,
            before,
            {
              to: 'VERIFYING',
              correlationId: env.correlation_id,
              historyReason: 'No-op regression',
              actorRole: 'SYSTEM',
            },
            NOW,
          ),
        ).to.equal(false);
      }),
    ).to.deep.equal({ kind: 'ack' });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: before.id } })).to.deep.equal(
      before,
    );
    expect(await counts(before.id, env.event_id)).to.deep.equal({
      history: 0,
      outbox: 0,
      marker: 1,
    });
  });
});
