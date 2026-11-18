import { randomUUID } from 'node:crypto';
import {
  OutboxWriter,
  processDelivery,
  type EventConsumer,
  type Subscription,
} from '@internpath/common';
import type { EventEnvelope } from '@internpath/contracts';
import { expect } from 'chai';
import sinon from 'sinon';
import { JobVerifiedConsumer } from '../../src/events/consumers/job-verified.consumer';
import { ReportThresholdReachedConsumer } from '../../src/events/consumers/report-threshold-reached.consumer';
import type { Tx } from '../../src/prisma/types';
import { JobReportRoundCleanupService } from '../../src/status/job-report-round-cleanup.service';
import { JobReportRoundService } from '../../src/status/job-report-round.service';
import { JobStatusTransitionService } from '../../src/status/job-status-transition.service';
import { JobVerificationService } from '../../src/status/job-verification.service';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { jobVerified, NOW, reportThreshold, seedJob } from '../support/job-events';
import { eventually } from '../support/wait';

const PUBLISHED_AT = new Date('2026-11-01T03:00:00Z');

describe('Job report rounds (PostgreSQL + shared EventConsumer transactions)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  const subscriptions = new Map<string, Subscription<Tx>>();
  let clock: sinon.SinonFakeTimers;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    const transitions = new JobStatusTransitionService(new OutboxWriter());
    const rounds = new JobReportRoundService(transitions);
    const capture = {
      subscribe: async (sub: Subscription<Tx>) => void subscriptions.set(sub.type, sub),
    } as EventConsumer<Tx>;
    await new ReportThresholdReachedConsumer(capture, rounds).onModuleInit();
    await new JobVerifiedConsumer(
      capture,
      new JobVerificationService(transitions, rounds),
    ).onModuleInit();
  });
  after(async () => db?.drop());
  beforeEach(() => {
    clock = sinon.useFakeTimers({ now: NOW, toFake: ['Date'] });
  });
  afterEach(() => clock.restore());

  const deliver = (env: EventEnvelope, afterWrites?: () => void | Promise<void>, retryCount = 0) =>
    processDelivery<Tx>({
      raw: Buffer.from(JSON.stringify(env)),
      queue: `job.${env.type}`,
      sub: subscriptions.get(env.type)!,
      retryCount,
      maxRetries: 3,
      runInTransaction: (fn) =>
        db.prisma.$transaction(async (tx) => {
          const result = await fn(tx);
          await afterWrites?.();
          return result;
        }),
    });
  const ack = async (env: EventEnvelope) => {
    expect(await deliver(env)).to.deep.equal({ kind: 'ack' });
  };
  const resolution = (
    job: Awaited<ReturnType<typeof seedJob>>,
    queueItemId: string | undefined,
    decision: 'RESTORE' | 'REMOVE' = 'RESTORE',
  ) => {
    const env = jobVerified(job.id, job.currentSubmissionId!, decision);
    env.payload.decided_by = 'ADMIN';
    env.payload.queue_item_id = queueItemId;
    return env;
  };
  const state = async (id: string) => ({
    job: await db.prisma.job.findUniqueOrThrow({ where: { id } }),
    rounds: await db.prisma.reportRound.findMany({
      where: { jobId: id },
      orderBy: { queueItemId: 'asc' },
    }),
    history: await db.prisma.statusHistory.findMany({
      where: { entityId: id },
      orderBy: { id: 'asc' },
    }),
    outbox: await db.prisma.outboxEvent.findMany({
      where: { aggregateId: id },
      orderBy: { id: 'asc' },
    }),
  });
  const marker = (env: EventEnvelope) =>
    db.prisma.processedEvent.count({
      where: { eventId: env.event_id, consumer: `job.${env.type}` },
    });

  const holdAfterWrites = (env: EventEnvelope) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let paused = false;
    const finished = deliver(env, () => {
      paused = true;
      return gate;
    });
    return { finished, release, wait: () => eventually(async () => paused) };
  };

  it('dead-letters malformed E04 payloads before writes and accepts a valid same-ID delivery', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const before = await state(job.id);
    const valid = reportThreshold(job.id, job.companyId);
    const invalidFields = [
      ...(['job_id', 'company_id', 'queue_item_id'] as const).flatMap((field) =>
        [null, undefined, '', 1, 'not-a-uuid'].map((value) => ({ [field]: value })),
      ),
      ...[null, undefined, 0, -1, 1.5, '3'].map((report_count) => ({ report_count })),
      ...[
        '2026-11-15T10:00:00.000900Z',
        '2026-11-15T10:00:00.000100Z',
        '2026-11-15T10:00:00.1234Z',
        '2026-11-15T10:00:00.123456789Z',
        null,
        undefined,
        1763200800000,
        '',
        'not a date',
        '2026-02-30T10:00:00Z',
        '0000-01-01T10:00:00Z',
        '1900-02-29T10:00:00Z',
        '2026-13-01T10:00:00Z',
        '2026-11-15T24:00:00Z',
        '2026-11-15T10:60:00Z',
        '2026-11-15T10:00:60Z',
        '2026-11-15',
        '2026-11-15T10:00:00',
        '2026-11-15T10:00:00+00:00',
        '2026-11-15T17:00:00+07:00',
        '2026-11-15T10:00:00z',
        '2026-11-15T10:00:00.Z',
        '2026-11-15T10:00:00Z\n',
      ].map((reached_at) => ({ reached_at })),
    ];
    for (const payload of [
      null,
      ...invalidFields.map((fields) => ({ ...valid.payload, ...fields })),
    ]) {
      const invalid = { ...valid, payload };
      expect(await deliver(invalid), JSON.stringify(payload)).to.deep.equal({
        kind: 'dead-letter',
        reason: 'invalid_message',
        eventId: invalid.event_id,
        type: invalid.type,
      });
      expect(await state(job.id)).to.deep.equal(before);
      expect(await marker(invalid)).to.equal(0);
    }

    await ack(valid);
    const suspended = await state(job.id);
    expect(suspended.job.status).to.equal('SUSPENDED');
    expect(suspended.rounds).to.have.length(1);
    expect(suspended.rounds[0]).to.deep.include({
      queueItemId: valid.payload.queue_item_id,
      jobId: job.id,
      reachedAt: new Date(valid.payload.reached_at),
      status: 'ACTIVE',
    });
    expect(await marker(valid)).to.equal(1);
  });

  it('stores valid UTC timestamps exactly at zero through three fractional digits', async () => {
    for (const [sent, stored] of [
      ['2026-11-15T10:00:00Z', '2026-11-15T10:00:00.000Z'],
      ['2026-11-15T10:00:00.1Z', '2026-11-15T10:00:00.100Z'],
      ['2026-11-15T10:00:00.01Z', '2026-11-15T10:00:00.010Z'],
      ['2000-02-29T23:59:59.001Z', '2000-02-29T23:59:59.001Z'],
      ['0096-02-29T00:00:00.1Z', '0096-02-29T00:00:00.100Z'],
    ]) {
      const job = await seedJob(db.prisma, 'PUBLISHED');
      const threshold = reportThreshold(job.id, job.companyId);
      threshold.payload.reached_at = sent;
      await ack(threshold);
      const accepted = await state(job.id);
      expect(accepted.job.status).to.equal('SUSPENDED');
      expect(accepted.rounds[0].reachedAt?.toISOString()).to.equal(stored);
      expect(await marker(threshold)).to.equal(1);
    }
  });

  for (const from of ['PUBLISHED', 'CLOSED'] as const) {
    it(`suspends and restores a ${from} Job with typed E03 effects, actor roles and unchanged publishedAt`, async () => {
      const job = await seedJob(db.prisma, from, { publishedAt: PUBLISHED_AT });
      const threshold = reportThreshold(job.id, job.companyId);
      await ack(threshold);
      const suspended = await state(job.id);
      expect(suspended.job).to.include({
        status: 'SUSPENDED',
        suspendedFromStatus: from,
        version: 5,
        entityVersion: 11,
      });
      expect(suspended.rounds).to.have.length(1);
      expect(suspended.rounds[0]).to.deep.include({
        queueItemId: threshold.payload.queue_item_id,
        jobId: job.id,
        reachedAt: NOW,
        status: 'ACTIVE',
        suspendedFromStatus: from,
      });
      expect(suspended.history).to.have.length(1);
      expect(suspended.history[0]).to.include({
        fromStatus: from,
        toStatus: 'SUSPENDED',
        actorRole: 'SYSTEM',
        actorId: null,
        correlationId: threshold.correlation_id,
      });
      expect(suspended.outbox).to.have.length(1);
      expect(suspended.outbox[0]).to.include({
        type: 'JobStatusChanged',
        correlationId: threshold.correlation_id,
      });
      expect(suspended.outbox[0].payload).to.deep.equal({
        job_id: job.id,
        company_id: job.companyId,
        from_status: from,
        to_status: 'SUSPENDED',
        entity_version: 11,
        changed_at: NOW.toISOString(),
        reason_code: 'REPORT_THRESHOLD',
        application_effect: 'FREEZE',
      });
      expect(await marker(threshold)).to.equal(1);

      const restore = resolution(job, threshold.payload.queue_item_id);
      await ack(restore);
      const restored = await state(job.id);
      expect(restored.job).to.include({
        status: from,
        version: 6,
        entityVersion: 12,
        suspendedFromStatus: null,
      });
      expect(restored.job.publishedAt).to.deep.equal(PUBLISHED_AT);
      expect(restored.rounds).to.deep.equal([
        {
          ...suspended.rounds[0],
          status: 'CLOSED',
          decision: 'RESTORE',
          decidedAt: new Date(restore.payload.decided_at),
          closedAt: NOW,
          decidedBy: restore.payload.decided_by,
          correlationId: restore.correlation_id,
        },
      ]);
      expect(restored.history).to.have.length(2);
      expect(restored.history.find((h) => h.correlationId === restore.correlation_id)).to.include({
        fromStatus: 'SUSPENDED',
        toStatus: from,
        actorRole: 'PLATFORM_ADMIN',
        actorId: null,
      });
      expect(restored.outbox).to.have.length(2);
      expect(
        restored.outbox.find((e) => e.correlationId === restore.correlation_id)?.payload,
      ).to.include({
        to_status: from,
        application_effect: 'UNFREEZE',
        reason_code: 'ADMIN_DISMISSED',
      });
      expect(await marker(restore)).to.equal(1);
      await ack(restore);
      await ack({ ...restore, event_id: randomUUID() });
      expect(await state(job.id)).to.deep.equal(restored);
    });
  }

  for (const [now, status] of [
    ['2026-11-15T16:59:59.999Z', 'PUBLISHED'],
    ['2026-11-15T17:00:00.000Z', 'CLOSED'],
  ] as const) {
    it(`restores to ${status} at ${now} for a November 15 Bangkok deadline`, async () => {
      const job = await seedJob(db.prisma, 'PUBLISHED', {
        applicationDeadline: new Date('2026-11-15'),
        publishedAt: PUBLISHED_AT,
      });
      const threshold = reportThreshold(job.id, job.companyId);
      await ack(threshold);
      clock.setSystemTime(new Date(now));
      await ack(resolution(job, threshold.payload.queue_item_id));
      const restored = await state(job.id);
      expect(restored.job.status).to.equal(status);
      expect(restored.job.publishedAt).to.deep.equal(PUBLISHED_AT);
      expect(
        restored.outbox.find((e) => e.correlationId !== threshold.correlation_id)?.payload,
      ).to.include({ to_status: status, application_effect: 'UNFREEZE' });
    });
  }

  it('skips exact E04 deliveries and same-round replays before and after closure', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const first = reportThreshold(job.id, job.companyId);
    await ack(first);
    const active = await state(job.id);
    await ack(first);
    const replay = { ...first, event_id: randomUUID() };
    await ack(replay);
    expect(await marker(replay)).to.equal(1);
    expect(await state(job.id)).to.deep.equal(active);
    await ack(resolution(job, first.payload.queue_item_id));
    const closed = await state(job.id);
    // Even modifying the timestamp cannot reopen an accepted queue item.
    await ack({
      ...first,
      event_id: randomUUID(),
      payload: { ...first.payload, reached_at: '2026-11-16T00:00:00Z' },
    });
    expect(await state(job.id)).to.deep.equal(closed);
  });

  it('ignores older round timestamps and old resolutions after RESTORE and during a newer round', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const first = reportThreshold(job.id, job.companyId);
    await ack(first);
    await ack(resolution(job, first.payload.queue_item_id));
    const restored = await state(job.id);
    const old = reportThreshold(job.id, job.companyId);
    old.payload.reached_at = '2026-11-14T00:00:00Z';
    await ack(old);
    expect(await state(job.id)).to.deep.equal(restored);
    const next = reportThreshold(job.id, job.companyId);
    next.payload.reached_at = '2026-11-16T00:00:00Z';
    await ack(next);
    const active = await state(job.id);
    await ack({ ...old, event_id: randomUUID() });
    await ack({ ...first, event_id: randomUUID() });
    await ack(resolution(job, first.payload.queue_item_id, 'REMOVE'));
    expect(active.rounds.map((r) => r.status).sort()).to.deep.equal(['ACTIVE', 'CLOSED']);
    expect(await state(job.id)).to.deep.equal(active);
  });

  it('skips strictly older milliseconds and accepts equal instants with a different round ID', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const first = reportThreshold(job.id, job.companyId);
    first.payload.reached_at = '2026-11-15T10:00:00.10Z';
    await ack(first);
    await ack(resolution(job, first.payload.queue_item_id));
    const before = await state(job.id);

    const older = reportThreshold(job.id, job.companyId);
    older.payload.reached_at = '2026-11-15T10:00:00.099Z';
    await ack(older);
    expect(await state(job.id)).to.deep.equal(before);

    const equal = reportThreshold(job.id, job.companyId);
    equal.payload.reached_at = '2026-11-15T10:00:00.100Z';
    await ack(equal);
    const accepted = await state(job.id);
    expect(accepted.job.status).to.equal('SUSPENDED');
    expect(accepted.rounds).to.have.length(2);
    expect(accepted.rounds.find((round) => round.status === 'ACTIVE')).to.deep.include({
      queueItemId: equal.payload.queue_item_id,
      reachedAt: before.rounds[0].reachedAt,
    });
  });

  it('skips E04 for ineligible status or wrong company and does not reserve the round ID', async () => {
    const job = await seedJob(db.prisma, 'VERIFYING');
    const before = await state(job.id);
    const event = reportThreshold(job.id, job.companyId);
    await ack(event);
    expect(await state(job.id)).to.deep.equal(before);
    await db.prisma.job.update({ where: { id: job.id }, data: { status: 'PUBLISHED' } });
    const published = await state(job.id);
    await ack(reportThreshold(job.id, randomUUID()));
    expect(await state(job.id)).to.deep.equal(published);
    await ack({ ...event, event_id: randomUUID() });
    expect((await state(job.id)).job.status).to.equal('SUSPENDED');
  });

  it('skips missing, invalid, foreign or conflicting report resolutions and preserves the active round', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const other = await seedJob(db.prisma, 'CLOSED');
    const first = reportThreshold(job.id, job.companyId);
    const foreign = reportThreshold(other.id, other.companyId);
    await ack(first);
    await ack(foreign);
    const active = await state(job.id);
    const matching = resolution(job, first.payload.queue_item_id);
    const missingSubmission = {
      ...matching,
      payload: { ...matching.payload, submission_id: undefined },
    };
    for (const event of [
      resolution(job, undefined),
      resolution(job, 'invalid'),
      resolution(job, foreign.payload.queue_item_id, 'REMOVE'),
      resolution(job, randomUUID()),
      missingSubmission,
    ]) {
      await ack(event);
      expect(await marker(event)).to.equal(1);
    }
    expect(await state(job.id)).to.deep.equal(active);
    expect((await state(other.id)).rounds[0].status).to.equal('ACTIVE');
  });

  for (const decision of ['RESTORE', 'REMOVE'] as const) {
    it(`applies active ${decision} to its round after the current submission changes`, async () => {
      const job = await seedJob(db.prisma, 'PUBLISHED');
      const threshold = reportThreshold(job.id, job.companyId);
      await ack(threshold);
      const replacement = randomUUID();
      await db.prisma.job.update({
        where: { id: job.id },
        data: { currentSubmissionId: replacement },
      });
      await ack(resolution(job, threshold.payload.queue_item_id, decision));
      const resolved = await state(job.id);
      expect(resolved.job).to.include({
        currentSubmissionId: replacement,
        status: decision === 'RESTORE' ? 'PUBLISHED' : 'REMOVED',
        suspendedFromStatus: null,
        version: 6,
        entityVersion: 12,
      });
      expect(resolved.rounds[0]).to.include({
        status: 'CLOSED',
        decision,
        suspendedFromStatus: 'PUBLISHED',
      });
    });
  }

  it('parks an early RESTORE atomically, preserves it on retry, and closes without business writes', async () => {
    const job = await seedJob(db.prisma, 'CLOSED');
    const threshold = reportThreshold(job.id, job.companyId);
    const restore = resolution(job, threshold.payload.queue_item_id);
    const fail = () => {
      throw new Error('Injected rollback');
    };
    const before = await state(job.id);
    expect(await deliver(restore, fail)).to.deep.equal({ kind: 'retry', nextCount: 1 });
    expect(await marker(restore)).to.equal(0);
    expect(await state(job.id)).to.deep.equal(before);
    await ack(restore);

    const parked = await state(job.id);
    expect(parked.job).to.deep.equal(job);
    expect(parked.history).to.have.length(0);
    expect(parked.outbox).to.have.length(0);
    expect(parked.rounds).to.have.length(1);
    expect(parked.rounds[0]).to.deep.include({
      status: 'DECIDED',
      decision: 'RESTORE',
      decidedAt: new Date(restore.payload.decided_at),
      decidedBy: 'ADMIN',
      correlationId: restore.correlation_id,
      reachedAt: null,
      suspendedFromStatus: null,
      closedAt: null,
    });
    expect(await marker(restore)).to.equal(1);
    await ack(restore);
    await ack({
      ...restore,
      event_id: randomUUID(),
      payload: { ...restore.payload, decided_at: '2026-11-16T00:00:00Z' },
    });
    await ack(resolution(job, threshold.payload.queue_item_id, 'REMOVE'));
    expect(await state(job.id)).to.deep.equal(parked);

    expect(await deliver(threshold, fail)).to.deep.equal({ kind: 'retry', nextCount: 1 });
    expect(await state(job.id)).to.deep.equal(parked);
    expect(await marker(threshold)).to.equal(0);
    await ack(threshold);
    const closed = await state(job.id);
    expect(closed).to.deep.equal({
      ...parked,
      rounds: [{ ...parked.rounds[0], status: 'CLOSED', reachedAt: NOW, closedAt: NOW }],
    });
    expect(await marker(threshold)).to.equal(1);
    await ack({ ...threshold, event_id: randomUUID() });
    expect(await state(job.id)).to.deep.equal(closed);
  });

  it('keeps an unmatched RESTORE parked when E04 is stale or the Job is ineligible', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const latest = reportThreshold(job.id, job.companyId);
    await ack(latest);
    await ack(resolution(job, latest.payload.queue_item_id));
    const old = reportThreshold(job.id, job.companyId);
    old.payload.reached_at = '2026-11-14T00:00:00Z';
    await ack(resolution(job, old.payload.queue_item_id));
    const parked = await state(job.id);
    await ack(old);
    expect(await state(job.id)).to.deep.equal(parked);

    const ineligible = await seedJob(db.prisma, 'VERIFYING');
    const other = reportThreshold(ineligible.id, ineligible.companyId);
    await ack(resolution(ineligible, other.payload.queue_item_id));
    const before = await state(ineligible.id);
    await ack(other);
    expect(await state(ineligible.id)).to.deep.equal(before);
  });

  it('rolls back early and active report decisions without an original UUID correlation ID', async () => {
    for (const active of [false, true]) {
      const job = await seedJob(db.prisma, 'PUBLISHED');
      const threshold = reportThreshold(job.id, job.companyId);
      if (active) await ack(threshold);
      const before = await state(job.id);
      const remove = resolution(job, threshold.payload.queue_item_id, 'REMOVE');

      for (const correlation_id of [undefined, 'non-uuid-correlation']) {
        const invalid = { ...remove, correlation_id: correlation_id as string };
        for (const retryCount of [0, 1, 2]) {
          expect(await deliver(invalid, undefined, retryCount)).to.deep.equal({
            kind: 'retry',
            nextCount: retryCount + 1,
          });
        }
        expect(await deliver(invalid, undefined, 3)).to.deep.equal({
          kind: 'dead-letter',
          reason: 'retries_exhausted',
          eventId: invalid.event_id,
          type: invalid.type,
        });
        expect(await marker(invalid)).to.equal(0);
        expect(await state(job.id)).to.deep.equal(before);
      }

      await ack(remove);
      const [round] = (await state(job.id)).rounds;
      expect(round).to.include({
        correlationId: remove.correlation_id,
        status: active ? 'CLOSED' : 'DECIDED',
      });
    }
  });

  it('acknowledges and skips report decisions with invalid timestamps or required routing fields', async () => {
    for (const active of [false, true]) {
      const job = await seedJob(db.prisma, 'PUBLISHED');
      const threshold = reportThreshold(job.id, job.companyId);
      if (active) await ack(threshold);
      const before = await state(job.id);
      const decision = resolution(job, threshold.payload.queue_item_id, 'REMOVE');
      const invalidFields = [
        ...[
          null,
          undefined,
          '',
          '2026-11-15T10:00:00.000900Z',
          '2026-11-15T10:00:00+00:00',
          '2026-02-29T10:00:00Z',
          '2026-11-15T24:00:00Z',
        ].map((decided_at) => ({ decided_at })),
        { job_id: undefined },
        { queue_item_id: 'not-a-uuid' },
        { submission_id: undefined },
        { decided_by: 'OTHER' },
      ];
      for (const fields of invalidFields) {
        const invalid = {
          ...decision,
          event_id: randomUUID(),
          payload: { ...decision.payload, ...fields },
        };
        await ack(invalid);
        expect(await marker(invalid)).to.equal(1);
        expect(await state(job.id)).to.deep.equal(before);
      }
    }
  });

  for (const [from, decidedBy, role] of [
    ['PUBLISHED', 'ADMIN', 'PLATFORM_ADMIN'],
    ['CLOSED', 'SYSTEM', 'SYSTEM'],
  ] as const) {
    it(`applies deferred REMOVE from ${from}, preserves ${decidedBy} provenance and rolls back the entire pair on failure`, async () => {
      const job = await seedJob(db.prisma, from, { publishedAt: PUBLISHED_AT });
      const threshold = reportThreshold(job.id, job.companyId);
      const remove = resolution(job, threshold.payload.queue_item_id, 'REMOVE');
      remove.payload.decided_by = decidedBy;
      remove.payload.decided_at = '2026-11-15T09:30:00.000Z';
      remove.payload.reasons = [{ code: 'REPORT_UPHELD', detail: 'Fixture detail' }];
      await ack(remove);
      await ack(resolution(job, threshold.payload.queue_item_id));
      const parked = await state(job.id);
      expect(parked.job).to.deep.equal(job);
      expect(parked.outbox).to.have.length(0);
      expect(parked.history).to.have.length(0);
      expect(parked.rounds).to.have.length(1);
      expect(parked.rounds[0]).to.deep.include({
        status: 'DECIDED',
        decision: 'REMOVE',
        decidedBy,
        correlationId: remove.correlation_id,
        reachedAt: null,
        decidedAt: new Date(remove.payload.decided_at),
      });
      expect(
        await deliver(threshold, () => {
          throw new Error('Injected rollback');
        }),
      ).to.deep.equal({ kind: 'retry', nextCount: 1 });
      expect(await state(job.id)).to.deep.equal(parked);
      expect(await marker(threshold)).to.equal(0);
      expect(await marker(remove)).to.equal(1);

      await ack(threshold);
      const closed = await state(job.id);
      expect(closed.job).to.deep.include({
        status: 'REMOVED',
        version: job.version + 2,
        entityVersion: job.entityVersion + 2,
        publishedAt: PUBLISHED_AT,
        suspendedFromStatus: null,
      });
      expect(closed.rounds).to.deep.equal([
        {
          ...parked.rounds[0],
          status: 'CLOSED',
          reachedAt: NOW,
          closedAt: NOW,
          suspendedFromStatus: from,
        },
      ]);
      expect(closed.history).to.have.length(2);
      const [suspended, removed] = [...closed.history].sort(
        (a, b) => +a.occurredAt - +b.occurredAt,
      );
      expect(suspended).to.include({
        fromStatus: from,
        toStatus: 'SUSPENDED',
        actorRole: 'SYSTEM',
        actorId: null,
        reason: 'REPORT_THRESHOLD',
        correlationId: threshold.correlation_id,
      });
      expect(removed).to.include({
        fromStatus: 'SUSPENDED',
        toStatus: 'REMOVED',
        actorRole: role,
        actorId: null,
        reason: remove.payload.decision,
        correlationId: remove.correlation_id,
      });
      expect(suspended.occurredAt < removed.occurredAt).to.equal(true);
      expect(removed.occurredAt > new Date(remove.payload.decided_at)).to.equal(true);
      expect(closed.outbox).to.have.length(2);
      const [freeze, cancel] = [...closed.outbox].sort((a, b) => +a.createdAt - +b.createdAt);
      expect(freeze.correlationId).to.equal(threshold.correlation_id);
      expect(freeze.payload).to.include({
        from_status: from,
        to_status: 'SUSPENDED',
        entity_version: job.entityVersion + 1,
        application_effect: 'FREEZE',
        reason_code: 'REPORT_THRESHOLD',
      });
      expect(cancel.correlationId).to.equal(remove.correlation_id);
      expect(cancel.payload).to.include({
        from_status: 'SUSPENDED',
        to_status: 'REMOVED',
        entity_version: job.entityVersion + 2,
        application_effect: 'CANCEL_PRE_APPROVAL',
        changed_at: removed.occurredAt.toISOString(),
      });
      expect(cancel.payload).not.to.have.any.keys('reason', 'reason_code', 'decided_at');
      await ack({ ...threshold, event_id: randomUUID() });
      expect(await state(job.id)).to.deep.equal(closed);

      // Apply the same decision with E04 already active and compare E02-derived audit fields.
      const normalJob = await seedJob(db.prisma, from);
      const normalThreshold = reportThreshold(normalJob.id, normalJob.companyId);
      await ack(normalThreshold);
      await ack({
        ...remove,
        event_id: randomUUID(),
        payload: {
          ...remove.payload,
          job_id: normalJob.id,
          queue_item_id: normalThreshold.payload.queue_item_id,
          submission_id: normalJob.currentSubmissionId!,
        },
      });
      const normal = await state(normalJob.id);
      const normalRemoval = normal.history.find((row) => row.toStatus === 'REMOVED');
      expect(normalRemoval).to.deep.include({
        actorRole: removed.actorRole,
        actorId: removed.actorId,
        reason: removed.reason,
        correlationId: removed.correlationId,
        occurredAt: NOW,
      });
      const normalCancel = normal.outbox.find((row) => row.correlationId === remove.correlation_id);
      expect(normalCancel?.payload).to.deep.equal({
        job_id: normalJob.id,
        company_id: normalJob.companyId,
        from_status: 'SUSPENDED',
        to_status: 'REMOVED',
        entity_version: normalJob.entityVersion + 2,
        changed_at: NOW.toISOString(),
        application_effect: 'CANCEL_PRE_APPROVAL',
      });
    });
  }

  for (const [decision, e02First] of [
    ['RESTORE', true],
    ['RESTORE', false],
    ['REMOVE', true],
    ['REMOVE', false],
  ] as const) {
    it(`serializes concurrent ${decision} and E04 with ${e02First ? decision : 'E04'} holding the Job lock first`, async () => {
      const job = await seedJob(db.prisma, 'PUBLISHED');
      const threshold = reportThreshold(job.id, job.companyId);
      const resolutionEvent = resolution(job, threshold.payload.queue_item_id, decision);
      const [first, second] = e02First
        ? [resolutionEvent, threshold]
        : [threshold, resolutionEvent];
      const held = holdAfterWrites(first);
      let concurrent: ReturnType<typeof deliver> | undefined;
      try {
        await held.wait();
        concurrent = deliver(second);
        await eventually(async () => {
          const [row] = await db.prisma.$queryRaw<Array<{ waiting: boolean }>>`
            SELECT EXISTS (
              SELECT 1 FROM pg_stat_activity WHERE datname = current_database()
                AND wait_event_type = 'Lock' AND query LIKE '%FROM jobs WHERE id = %FOR UPDATE%'
            ) AS waiting
          `;
          return row.waiting;
        });
      } finally {
        held.release();
        expect(await held.finished).to.deep.equal({ kind: 'ack' });
        if (concurrent) expect(await concurrent).to.deep.equal({ kind: 'ack' });
      }
      const closed = await state(job.id);
      expect(closed.rounds).to.have.length(1);
      expect(closed.rounds[0]).to.include({ status: 'CLOSED', decision });
      const transitions = e02First && decision === 'RESTORE' ? 0 : 2;
      expect(closed.job).to.include({
        status: decision === 'REMOVE' ? 'REMOVED' : 'PUBLISHED',
        version: job.version + transitions,
        entityVersion: job.entityVersion + transitions,
        suspendedFromStatus: null,
      });
      expect(closed.history).to.have.length(transitions);
      expect(closed.outbox).to.have.length(transitions);
    });
  }

  it('retains protected rounds and skips an expired decision while E04 holds its Job lock', async () => {
    const cleanup = new JobReportRoundCleanupService(db.prisma);
    const expired = new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000);
    const boundary = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
    const park = async (createdAt: Date, decision: 'RESTORE' | 'REMOVE' = 'RESTORE') => {
      const job = await seedJob(db.prisma, 'PUBLISHED');
      const threshold = reportThreshold(job.id, job.companyId);
      const event = resolution(job, threshold.payload.queue_item_id, decision);
      await ack(event);
      const [round] = (await state(job.id)).rounds;
      expect(round).to.include({
        status: 'DECIDED',
        decision,
        decidedBy: event.payload.decided_by,
        correlationId: event.correlation_id,
      });
      await db.prisma.reportRound.update({ where: { id: round.id }, data: { createdAt } });
      return { job, threshold, round };
    };
    const old = await park(expired, 'REMOVE');
    const keep = await park(boundary);
    const matching = await park(expired);
    const active = await seedJob(db.prisma, 'CLOSED');
    await ack(reportThreshold(active.id, active.companyId));
    await db.prisma.reportRound.updateMany({
      where: { jobId: active.id },
      data: { createdAt: expired },
    });

    const held = holdAfterWrites(matching.threshold);
    try {
      await held.wait();
      await cleanup.removeExpired(NOW);
      expect(await db.prisma.reportRound.findUnique({ where: { id: old.round.id } })).to.equal(
        null,
      );
      expect((await state(matching.job.id)).rounds[0].status).to.equal('DECIDED');
    } finally {
      held.release();
      expect(await held.finished).to.deep.equal({ kind: 'ack' });
    }
    await cleanup.removeExpired(NOW);
    expect((await state(matching.job.id)).rounds[0].status).to.equal('CLOSED');
    expect((await state(keep.job.id)).rounds[0].status).to.equal('DECIDED');
    expect((await state(active.id)).rounds[0].status).to.equal('ACTIVE');
  });

  it('commits one concurrent suspension and one concurrent resolution per Job', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const threshold = reportThreshold(job.id, job.companyId);
    await Promise.all([
      ack(threshold),
      ack({ ...threshold, event_id: randomUUID() }),
      ack(reportThreshold(job.id, job.companyId)),
    ]);
    const active = await state(job.id);
    expect(active.job).to.include({ status: 'SUSPENDED', entityVersion: 11, version: 5 });
    expect(active.rounds).to.have.length(1);
    expect(active.history).to.have.length(1);
    expect(active.outbox).to.have.length(1);
    const key = active.rounds[0].queueItemId;
    await Promise.all([ack(resolution(job, key)), ack(resolution(job, key, 'REMOVE'))]);
    const resolved = await state(job.id);
    expect(['PUBLISHED', 'REMOVED']).to.include(resolved.job.status);
    expect(resolved.job).to.include({ entityVersion: 12, version: 6 });
    expect(resolved.rounds).to.have.length(1);
    expect(resolved.rounds[0]).to.include({
      id: active.rounds[0].id,
      status: 'CLOSED',
      suspendedFromStatus: 'PUBLISHED',
    });
    expect(resolved.history).to.have.length(2);
    expect(resolved.outbox).to.have.length(2);
  });

  it('rolls back each round transition with history, E03 and the marker, then retries and removes once', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { publishedAt: PUBLISHED_AT });
    const threshold = reportThreshold(job.id, job.companyId);
    const remove = resolution(job, threshold.payload.queue_item_id, 'REMOVE');
    for (const env of [threshold, remove]) {
      const before = await state(job.id);
      expect(
        await deliver(env, () => {
          throw new Error('Injected failure after all event writes');
        }),
      ).to.deep.equal({
        kind: 'retry',
        nextCount: 1,
      });
      expect(await state(job.id)).to.deep.equal(before);
      expect(await marker(env)).to.equal(0);
      await ack(env);
      expect(await marker(env)).to.equal(1);
    }
    const removed = await state(job.id);
    expect(removed.job).to.include({
      status: 'REMOVED',
      version: 6,
      entityVersion: 12,
      suspendedFromStatus: null,
    });
    expect(removed.job.publishedAt).to.deep.equal(PUBLISHED_AT);
    expect(removed.rounds[0]).to.deep.include({
      status: 'CLOSED',
      decision: 'REMOVE',
      decidedAt: new Date(remove.payload.decided_at),
      closedAt: NOW,
      suspendedFromStatus: 'PUBLISHED',
    });
    expect(removed.history).to.have.length(2);
    expect(removed.history.find((h) => h.correlationId === remove.correlation_id)).to.include({
      actorRole: 'PLATFORM_ADMIN',
      actorId: null,
    });
    expect(removed.outbox).to.have.length(2);
    expect(
      removed.outbox.find((e) => e.correlationId === remove.correlation_id)?.payload,
    ).to.include({ to_status: 'REMOVED', application_effect: 'CANCEL_PRE_APPROVAL' });
    await ack(remove);
    await ack({ ...remove, event_id: randomUUID() });
    expect(await state(job.id)).to.deep.equal(removed);
  });
});
