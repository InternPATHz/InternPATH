import { randomUUID } from 'node:crypto';
import { processDelivery, type EventConsumer, type Subscription } from '@internpath/common';
import type { EventEnvelope } from '@internpath/contracts';
import { expect } from 'chai';
import sinon from 'sinon';
import { PrismaClient } from '../../generated/client';
import { UserDeletionRequestedConsumer } from '../../src/events/consumers/user-deletion-requested.consumer';
import type { Tx } from '../../src/prisma/types';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import {
  DELETION_QUEUE,
  anonymizedState,
  deletionMarker,
  deletionRequested,
  seedDeletionFixture,
} from '../support/user-deletion';
import { eventually } from '../support/wait';

async function authorization(tx: Tx) {
  const [settings] = await tx.$queryRaw<
    Array<{ pid: number; enabled: string | null; actor: string | null }>
  >`
    SELECT pg_backend_pid() AS pid,
           NULLIF(current_setting('internpath.anonymize', true), '') AS enabled,
           NULLIF(current_setting('internpath.anonymous_actor_id', true), '') AS actor
  `;
  return settings;
}

describe('Job E15 transaction-local anonymization (PostgreSQL)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let pinned: PrismaClient;
  let subscription: Subscription<Tx>;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    const url = new URL(db.url);
    url.searchParams.set('connection_limit', '1');
    pinned = new PrismaClient({ datasourceUrl: url.toString() });
    const capture = {
      subscribe: async (sub: Subscription<Tx>) => {
        subscription = sub;
      },
    } as EventConsumer<Tx>;
    await new UserDeletionRequestedConsumer(capture).onModuleInit();
  });

  after(async () => {
    try {
      await pinned?.$disconnect();
    } finally {
      await db?.drop();
    }
  });

  const deliver = (env: EventEnvelope, afterWrites?: (tx: Tx) => Promise<void>, client = pinned) =>
    processDelivery<Tx>({
      raw: Buffer.from(JSON.stringify(env)),
      queue: DELETION_QUEUE,
      sub: subscription,
      retryCount: 0,
      maxRetries: 3,
      runInTransaction: (fn) =>
        client.$transaction(
          async (tx) => {
            const result = await fn(tx);
            await afterWrites?.(tx);
            return result;
          },
          { timeout: 25_000 },
        ),
    });

  it('replaces only matching history actor IDs and expires authorization on the same connection', async () => {
    const event = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, event.payload.user_id);
    const before = await fixture.read();
    expect(before.history).to.have.length(4);
    const [firstMatch, unrelated, system, secondMatch] = before.history;
    expect(firstMatch.actorId).to.equal(event.payload.user_id);
    expect(secondMatch.actorId).to.equal(event.payload.user_id);
    expect(unrelated.actorId).to.be.a('string').and.not.equal(event.payload.user_id);
    expect(system.actorId).to.equal(null);
    const expected = {
      ...anonymizedState(before, event.payload),
      history: [
        { ...firstMatch, actorId: event.payload.anonymous_actor_id },
        unrelated,
        system,
        { ...secondMatch, actorId: event.payload.anonymous_actor_id },
      ],
    };
    let inTransaction: Awaited<ReturnType<typeof authorization>> | undefined;

    expect(
      await deliver(event, async (tx) => {
        inTransaction = await authorization(tx);
        expect(await fixture.read(tx)).to.deep.equal(expected);
        expect(await deletionMarker(tx, event.event_id)).to.equal(1);
        expect(await deletionMarker(db.prisma, event.event_id)).to.equal(0);
      }),
    ).to.deep.equal({ kind: 'ack' });

    expect(inTransaction).to.include({ enabled: 'on', actor: event.payload.anonymous_actor_id });
    expect(await pinned.$transaction(authorization)).to.deep.equal({
      pid: inTransaction?.pid,
      enabled: null,
      actor: null,
    });
    // The previously authorized replacement must still be rejected on this connection.
    const blocked = await pinned
      .$transaction(
        (tx) => tx.$executeRaw`
          UPDATE status_history SET actor_id = ${event.payload.anonymous_actor_id}::uuid
          WHERE id = ${unrelated.id}::uuid
        `,
      )
      .catch((error: unknown) => error);
    expect(blocked).to.have.nested.property('meta.code', 'P0001');
    expect(await fixture.read()).to.deep.equal(expected);
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
  });

  it('deduplicates the original delivery and safely reapplies an equivalent new event', async () => {
    const event = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, event.payload.user_id);
    const before = await fixture.read();
    const spy = sinon.spy(subscription, 'handler');
    try {
      expect(await deliver(event)).to.deep.equal({ kind: 'ack' });
      expect(await deliver(event)).to.deep.equal({ kind: 'ack' });
      expect(spy.callCount).to.equal(1);
      const repeated = { ...event, event_id: randomUUID() };
      expect(await deliver(repeated)).to.deep.equal({ kind: 'ack' });
      expect(spy.callCount).to.equal(2);
      expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
      expect(await deletionMarker(db.prisma, repeated.event_id)).to.equal(1);
      expect(await fixture.read()).to.deep.equal(anonymizedState(before, event.payload));
      expect(await db.prisma.outboxEvent.count()).to.equal(0);
    } finally {
      spy.restore();
    }
  });

  it('deduplicates overlapping E15 deliveries and anonymizes multiple owned records', async () => {
    const event = deletionRequested();
    const repeated = { ...event, event_id: randomUUID() };
    const userId = event.payload.user_id;
    const fixtures = [
      await seedDeletionFixture(db.prisma, userId),
      await seedDeletionFixture(db.prisma, userId),
    ];
    const read = () => Promise.all(fixtures.map((fixture) => fixture.read()));
    const before = await read();
    const expected = before.map((state) => anonymizedState(state, event.payload));
    const actors = before.flatMap(({ history }) => history.map(({ actorId }) => actorId));
    expect(
      before.flatMap(({ jobs }) => jobs.filter((job) => job.createdBy === userId)),
    ).to.have.length(2);
    expect(
      before.flatMap(({ submissions }) =>
        submissions.filter((submission) => submission.submittedBy === userId),
      ),
    ).to.have.length(2);
    expect(actors.filter((id) => id === userId)).to.have.length(4);
    expect(actors.filter((id) => id === null)).to.have.length(2);
    expect(actors.filter((id) => id !== null && id !== userId)).to.have.length(2);
    const markersBefore = await db.prisma.processedEvent.count();

    const url = new URL(db.url);
    url.searchParams.set('connection_limit', '3');
    const concurrent = new PrismaClient({ datasourceUrl: url.toString() });
    const spy = sinon.spy(subscription, 'handler');
    const deliveries: Array<ReturnType<typeof deliver>> = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holdingPid: number | undefined;

    try {
      deliveries.push(
        deliver(
          event,
          async (tx) => {
            const [backend] = await tx.$queryRaw<Array<{ pid: number }>>`
              SELECT pg_backend_pid() AS pid
            `;
            holdingPid = backend.pid;
            await gate;
          },
          concurrent,
        ),
      );
      await eventually(async () => holdingPid !== undefined);
      deliveries.push(
        deliver(event, undefined, concurrent),
        deliver(repeated, undefined, concurrent),
      );

      // Observe both contenders waiting on the first transaction before allowing it to commit.
      await eventually(async () => {
        const [result] = await db.prisma.$queryRaw<Array<{ waiting: number }>>`
          SELECT count(*)::int AS waiting
          FROM pg_stat_activity
          WHERE datname = current_database() AND wait_event_type = 'Lock'
            AND ${holdingPid}::int = ANY(pg_blocking_pids(pid))
        `;
        return result.waiting === 2;
      });
      expect(await read()).to.deep.equal(before);
      expect(await db.prisma.processedEvent.count()).to.equal(markersBefore);

      release();
      expect(await Promise.all(deliveries)).to.deep.equal([
        { kind: 'ack' },
        { kind: 'ack' },
        { kind: 'ack' },
      ]);
      expect(spy.args.map(([env]) => env.event_id)).to.deep.equal([
        event.event_id,
        repeated.event_id,
      ]);
      expect(await db.prisma.processedEvent.count()).to.equal(markersBefore + 2);
      expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
      expect(await deletionMarker(db.prisma, repeated.event_id)).to.equal(1);
      expect(await read()).to.deep.equal(expected);
      expect(await db.prisma.outboxEvent.count()).to.equal(0);
    } finally {
      release();
      await Promise.allSettled(deliveries);
      spy.restore();
      await concurrent.$disconnect();
    }
  });

  it('commits a processed marker for a non-matching user without changing records', async () => {
    const event = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, randomUUID());
    const before = await fixture.read();
    expect(await deliver(event)).to.deep.equal({ kind: 'ack' });
    expect(await fixture.read()).to.deep.equal(before);
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
  });

  it('rolls back the writes, marker, and authorization on failure and applies the retry', async () => {
    const event = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, event.payload.user_id);
    const before = await fixture.read();
    const expected = anonymizedState(before, event.payload);
    let failedPid: number | undefined;
    expect(
      await deliver(event, async (tx) => {
        expect(await fixture.read(tx)).to.deep.equal(expected);
        expect(await deletionMarker(tx, event.event_id)).to.equal(1);
        const settings = await authorization(tx);
        expect(settings).to.include({ enabled: 'on', actor: event.payload.anonymous_actor_id });
        failedPid = settings.pid;
        throw new Error('Test rollback after the E15 writes');
      }),
    ).to.deep.equal({ kind: 'retry', nextCount: 1 });
    expect(failedPid).to.be.a('number');
    expect(await pinned.$transaction(authorization)).to.deep.equal({
      pid: failedPid,
      enabled: null,
      actor: null,
    });
    expect(await fixture.read()).to.deep.equal(before);
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(0);
    expect(await deliver(event)).to.deep.equal({ kind: 'ack' });
    expect(await fixture.read()).to.deep.equal(expected);
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
  });

  it('retries invalid requests before configuring authorization or writing Job data', async () => {
    const event = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, event.payload.user_id);
    const before = await fixture.read();
    for (const malformed of [
      { ...event, payload: null },
      { ...event, producer: 'verification' as const },
      ...[
        { user_id: 'invalid' },
        { anonymous_actor_id: undefined },
        { anonymous_actor_id: 'invalid' },
        { anonymous_actor_id: event.payload.user_id.toUpperCase() },
        { mode: 'DELETE' },
        { role: '' },
        { company_id: 'invalid' },
        { requested_at: undefined },
        { requested_at: '2026-02-30T10:00:00Z' },
      ].map((fields) => ({ ...event, payload: { ...event.payload, ...fields } })),
    ]) {
      expect(await deliver(malformed)).to.deep.equal({ kind: 'retry', nextCount: 1 });
      expect(await deletionMarker(db.prisma, event.event_id)).to.equal(0);
    }
    expect(await deliver({ ...event, version: 2 })).to.include({
      kind: 'dead-letter',
      reason: 'unsupported_version',
    });
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(0);
    expect(await fixture.read()).to.deep.equal(before);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
  });
});
