import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BrokerConnection,
  consumerQueueName,
  DEFAULT_RETRY_DELAYS_MS,
  dlqName,
  OutboxRelay,
  PgRelayDb,
  RELAY_FACTORY,
  RETRY_COUNT_HEADER,
  retryQueueName,
  type RelayFactory,
} from '@internpath/common';
import {
  EVENTS_EXCHANGE,
  routingKey,
  type EventEnvelope,
  type JobStatusChangedPayload,
} from '@internpath/contracts';
import { expect } from 'chai';
import sinon from 'sinon';
import { JobModule } from '../../src/job.module';
import { JobStatusTransitionService } from '../../src/status/job-status-transition.service';
import { createBrokerSandboxOrSkip, type BrokerSandbox } from '../support/broker';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { jobVerified, reportThreshold, seedJob } from '../support/job-events';
import { eventually } from '../support/wait';

const TIMESTAMPS = {
  publishedAt: new Date('2026-11-14T10:00:00.000Z'),
  verifyingSince: new Date('2026-11-15T09:00:00.000Z'),
};

describe('E02 -> atomic Job transition -> E03 shared relay (real RabbitMQ + PostgreSQL)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let isolated: BrokerSandbox;
  let moduleRef: TestingModule;
  let publisher: BrokerConnection;
  let observer: Awaited<ReturnType<BrokerConnection['createChannel']>>;
  let sandbox: sinon.SinonSandbox;
  let ackCount = 0;
  let visibilityChecks = 0;
  const incoming = new Map<string, string>();
  const received: Array<{
    env: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>;
    messageId?: string;
    correlationId?: unknown;
  }> = [];

  before(async function () {
    await dbReachableOrSkip(this);
    isolated = await createBrokerSandboxOrSkip(this);
    db = await createTestDatabase();
    sandbox = sinon.createSandbox();
    publisher = new BrokerConnection({ url: isolated.url });
    await publisher.connect();
    observer = await publisher.createChannel();
    const queue = `job_it_${randomUUID()}`;
    await observer.assertQueue(queue, { durable: false });
    await observer.bindQueue(queue, EVENTS_EXCHANGE, routingKey('job', 'JobStatusChanged'));
    await observer.consume(queue, (msg) => {
      if (!msg) return;
      received.push({
        env: JSON.parse(msg.content.toString()),
        messageId: msg.properties.messageId,
        correlationId: msg.properties.headers?.['x-correlation-id'],
      });
      observer.ack(msg);
    });
    const factory: RelayFactory = async ({ broker, databaseUrl, service }) => {
      expect(databaseUrl).to.equal(db.url);
      expect(service).to.equal('job');
      const relayDb = new PgRelayDb(databaseUrl);
      const relay = new OutboxRelay({
        service,
        db: relayDb,
        publisher: broker,
        // Same shared relay implementation, with short polling intervals only in this test.
        busyIntervalMs: 20,
        idleIntervalMs: 50,
      });
      return {
        start: () => relay.start(),
        stop: async () => {
          try {
            await relay.stop();
          } finally {
            await relayDb.close();
          }
        },
      };
    };
    const relayFactory = sandbox.spy(factory);
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), JobModule],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JOB_DATABASE_URL: db.url,
          JOB_DIRECT_URL: db.url,
          RABBITMQ_URL: isolated.url,
        }),
      )
      .overrideProvider(RELAY_FACTORY)
      .useValue(relayFactory)
      .compile();
    const broker = moduleRef.get(BrokerConnection);
    const create = broker.createChannel.bind(broker);
    sandbox.stub(broker, 'createChannel').callsFake(async () => {
      const ch = await create();
      const ack = ch.ack.bind(ch);
      sandbox.stub(ch, 'ack').callsFake((...args) => {
        ackCount++;
        ack(...args);
      });
      return ch;
    });
    const publish = broker.publish.bind(broker);
    sandbox.stub(broker, 'publish').callsFake(async (exchange, key, body, options) => {
      if (exchange === EVENTS_EXCHANGE && key === routingKey('job', 'JobStatusChanged')) {
        const env = JSON.parse(body.toString()) as EventEnvelope<
          'JobStatusChanged',
          JobStatusChangedPayload
        >;
        const marker = await db.prisma.processedEvent.count({
          where: { eventId: incoming.get(env.payload.job_id)! },
        });
        const history = await db.prisma.statusHistory.count({
          where: {
            entityId: env.payload.job_id,
            toStatus: env.payload.to_status,
            correlationId: env.correlation_id,
          },
        });
        expect(marker).to.equal(1);
        expect(history).to.equal(1);
        expect(
          (await db.prisma.job.findUniqueOrThrow({ where: { id: env.payload.job_id } }))
            .entityVersion,
        ).to.be.at.least(env.payload.entity_version);
        visibilityChecks++;
      }
      return publish(exchange, key, body, options);
    });
    await moduleRef.init();
    sinon.assert.calledOnce(relayFactory);
  });

  after(async () => {
    try {
      await moduleRef?.close();
    } finally {
      try {
        await observer?.close().catch(() => undefined);
        await publisher?.close();
      } finally {
        sandbox?.restore();
        try {
          await db?.drop();
        } finally {
          await isolated?.drop();
        }
      }
    }
  });

  const send = (env: ReturnType<typeof jobVerified> | ReturnType<typeof reportThreshold>) => {
    incoming.set(env.payload.job_id, env.event_id);
    return publisher.publish(
      EVENTS_EXCHANGE,
      routingKey(env.producer, env.type),
      Buffer.from(JSON.stringify(env)),
      {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: env.event_id,
        headers: {
          'x-correlation-id': env.correlation_id,
        },
      },
    );
  };
  const emitted = (id: string) => received.filter((r) => r.env.payload.job_id === id);

  it('all six independent E02 decisions persist and publish typed E03 with the expected routing/correlation', async () => {
    const cases = [
      ['APPROVE', 'VERIFYING', 'PUBLISHED', 'SYSTEM', 'UNFREEZE'],
      ['PENDING_REVIEW', 'VERIFYING', 'PENDING_REVIEW', 'SYSTEM', 'FREEZE'],
      ['AUTO_REJECT', 'VERIFYING', 'AUTO_REJECTED', 'SYSTEM', 'CANCEL_PRE_APPROVAL'],
      ['APPEAL_ACCEPTED', 'AUTO_REJECTED', 'PENDING_REVIEW', 'ADMIN', 'FREEZE'],
      ['ADMIN_APPROVE', 'PENDING_REVIEW', 'PUBLISHED', 'ADMIN', 'UNFREEZE'],
      ['ADMIN_REJECT', 'PENDING_REVIEW', 'ADMIN_REJECTED', 'ADMIN', 'CANCEL_PRE_APPROVAL'],
    ] as const;
    for (const [decision, from, to, decidedBy, effect] of cases) {
      const job = await seedJob(db.prisma, from, TIMESTAMPS);
      const env = jobVerified(job.id, job.currentSubmissionId!, decision);
      env.payload.decided_by = decidedBy;
      await send(env);
      await eventually(async () => emitted(job.id).length > 0);
      const stored = await db.prisma.outboxEvent.findFirstOrThrow({
        where: { aggregateId: job.id },
      });
      await eventually(
        async () =>
          (await db.prisma.outboxEvent.findUniqueOrThrow({ where: { id: stored.id } }))
            .publishedAt !== null,
      );
      const actual = emitted(job.id)[0];
      expect(actual.env).to.include({
        event_id: stored.id,
        producer: 'job',
        type: 'JobStatusChanged',
        version: 1,
        correlation_id: env.correlation_id,
      });
      expect(actual.env.payload).to.include({
        job_id: job.id,
        company_id: job.companyId,
        from_status: from,
        to_status: to,
        entity_version: 11,
        application_effect: effect,
      });
      expect(actual.env.payload).to.deep.equal(stored.payload);
      expect(actual.messageId).to.equal(stored.id);
      expect(actual.correlationId).to.equal(env.correlation_id);
      const after = await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      const history = await db.prisma.statusHistory.findFirstOrThrow({
        where: { entityId: job.id },
      });
      const changedAt = new Date(actual.env.payload.changed_at);
      expect(after.publishedAt).to.deep.equal(to === 'PUBLISHED' ? changedAt : job.publishedAt);
      expect(after.verifyingSince).to.deep.equal(from === 'VERIFYING' ? null : job.verifyingSince);
      expect(history.occurredAt).to.deep.equal(changedAt);
      expect(history).to.include({
        actorRole: decidedBy === 'ADMIN' ? 'PLATFORM_ADMIN' : 'SYSTEM',
        actorId: null,
      });
    }
    expect(visibilityChecks).to.be.at.least(6);
  });

  it('duplicate IDs and stale distinct IDs ACK without extra status/history/outbox writes', async () => {
    const job = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
    const env = jobVerified(job.id, job.currentSubmissionId!);
    await send(env);
    await eventually(async () => emitted(job.id).length > 0);
    const accepted = await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const before = ackCount;
    await send(env);
    await send(env);
    const stale = { ...env, event_id: randomUUID() };
    await send(stale);
    await eventually(async () => ackCount === before + 3);
    expect(
      await db.prisma.processedEvent.count({
        where: { eventId: { in: [env.event_id, stale.event_id] } },
      }),
    ).to.equal(2);
    expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(1);
    expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(1);
    expect(
      (await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).entityVersion,
    ).to.equal(11);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(
      accepted,
    );
  });

  it('failure after E03 insertion rolls back every write, then the real retry queue recovers and publishes E03', async () => {
    const job = await seedJob(db.prisma, 'VERIFYING', TIMESTAMPS);
    const env = jobVerified(job.id, job.currentSubmissionId!);
    const service = moduleRef.get(JobStatusTransitionService);
    const original = service.change.bind(service);
    let attempts = 0;
    const change = sinon.stub(service, 'change').callsFake(async (...args) => {
      const value = await original(...args);
      if (++attempts === 1) throw new Error('Intentional failure after outbox insertion');
      return value;
    });
    try {
      const before = ackCount;
      await send(env);
      await eventually(async () => ackCount === before + 1);
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
      expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(0);
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
      expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(
        0,
      );
      expect(emitted(job.id)).to.have.length(0);
      await eventually(async () => emitted(job.id).length > 0, 15000);
      expect(attempts).to.equal(2);
      expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(1);
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(1);
      expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(
        1,
      );
    } finally {
      change.restore();
    }
  });

  it('acknowledges RESTORE without a queue item ID and makes no transition', async () => {
    const job = await seedJob(db.prisma, 'SUSPENDED', { suspendedFromStatus: 'PUBLISHED' });
    const env = jobVerified(job.id, job.currentSubmissionId!, 'RESTORE');
    const before = ackCount;
    await send(env);
    await eventually(async () => ackCount === before + 1);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
    expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(1);
    expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
    expect(emitted(job.id)).to.have.length(0);
  });

  it('retries a rolled-back E04, then publishes RESTORE and REMOVE for matching rounds', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', {
      publishedAt: TIMESTAMPS.publishedAt,
      applicationDeadline: new Date('2099-12-01'),
    });
    const first = reportThreshold(job.id, job.companyId);
    const transitions = moduleRef.get(JobStatusTransitionService);
    const original = transitions.change.bind(transitions);
    let attempts = 0;
    const change = sinon.stub(transitions, 'change').callsFake(async (...args) => {
      const result = await original(...args);
      if (++attempts === 1) throw new Error('Injected E04 failure after outbox insertion');
      return result;
    });
    try {
      const before = ackCount;
      await send(first);
      await eventually(async () => ackCount === before + 1);
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
      expect(await db.prisma.reportRound.count({ where: { jobId: job.id } })).to.equal(0);
      expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(0);
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
      expect(await db.prisma.processedEvent.count({ where: { eventId: first.event_id } })).to.equal(
        0,
      );
      await eventually(async () => emitted(job.id).length === 1, 15000);
      expect(attempts).to.equal(2);
    } finally {
      change.restore();
    }
    expect(emitted(job.id)[0].env.payload).to.include({
      to_status: 'SUSPENDED',
      reason_code: 'REPORT_THRESHOLD',
      application_effect: 'FREEZE',
    });
    const restore = jobVerified(job.id, job.currentSubmissionId!, 'RESTORE');
    restore.payload.queue_item_id = first.payload.queue_item_id;
    restore.payload.decided_by = 'ADMIN';
    await send(restore);
    await eventually(async () => emitted(job.id).length === 2);
    expect(emitted(job.id)[1].env.payload).to.include({
      to_status: 'PUBLISHED',
      reason_code: 'ADMIN_DISMISSED',
      application_effect: 'UNFREEZE',
    });
    const next = reportThreshold(job.id, job.companyId);
    next.payload.reached_at = new Date(Date.parse(first.payload.reached_at) + 1).toISOString();
    await send(next);
    await eventually(async () => emitted(job.id).length === 3);
    const remove = jobVerified(job.id, job.currentSubmissionId!, 'REMOVE');
    remove.payload.queue_item_id = next.payload.queue_item_id;
    remove.payload.decided_by = 'ADMIN';
    await send(remove);
    await eventually(async () => emitted(job.id).length === 4);
    expect(emitted(job.id)[3].env.payload).to.include({
      to_status: 'REMOVED',
      application_effect: 'CANCEL_PRE_APPROVAL',
    });
    const final = await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    expect(final).to.include({ status: 'REMOVED', version: 8, entityVersion: 14 });
    expect(final.publishedAt).to.deep.equal(job.publishedAt);
    expect(
      await db.prisma.reportRound.count({ where: { jobId: job.id, status: 'CLOSED' } }),
    ).to.equal(2);
    expect(
      await db.prisma.statusHistory.count({
        where: { entityId: job.id, actorRole: 'PLATFORM_ADMIN', actorId: null },
      }),
    ).to.equal(2);
  });

  for (const [decision, decidedBy, role] of [
    ['RESTORE', 'ADMIN', 'PLATFORM_ADMIN'],
    ['REMOVE', 'ADMIN', 'PLATFORM_ADMIN'],
    ['REMOVE', 'SYSTEM', 'SYSTEM'],
  ] as const) {
    it(`applies a parked ${decidedBy} ${decision} when E04 returns from the real retry queue`, async () => {
      const job = await seedJob(db.prisma, 'PUBLISHED', { publishedAt: TIMESTAMPS.publishedAt });
      const threshold = reportThreshold(job.id, job.companyId);
      const resolution = jobVerified(job.id, job.currentSubmissionId!, decision);
      resolution.payload.queue_item_id = threshold.payload.queue_item_id;
      resolution.payload.decided_by = decidedBy;
      const transitions = moduleRef.get(JobStatusTransitionService);
      const original = transitions.change.bind(transitions);
      let attempts = 0;
      const change = sinon.stub(transitions, 'change').callsFake(async (...args) => {
        const result = await original(...args);
        if (args[1].id === job.id && ++attempts === 1) throw new Error('Injected E04 rollback');
        return result;
      });
      const round = () =>
        db.prisma.reportRound.findUnique({
          where: {
            jobId_queueItemId: { jobId: job.id, queueItemId: threshold.payload.queue_item_id },
          },
        });
      const jobState = () => db.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      try {
        const before = ackCount;
        await send(threshold);
        await eventually(async () => ackCount === before + 1);
        expect(await round()).to.equal(null);
        expect(await jobState()).to.deep.equal(job);
        await send(resolution);
        await eventually(async () => (await round())?.status === 'DECIDED');
        expect(await round()).to.deep.include({
          decision,
          reachedAt: null,
          decidedBy,
          correlationId: resolution.correlation_id,
          decidedAt: new Date(resolution.payload.decided_at),
        });
        expect(await jobState()).to.deep.equal(job);
        expect(emitted(job.id)).to.deep.equal([]);
        await eventually(async () => (await round())?.status === 'CLOSED', 15000);
        expect(await round()).to.deep.include({
          decision,
          reachedAt: new Date(threshold.payload.reached_at),
          decidedBy,
          correlationId: resolution.correlation_id,
          suspendedFromStatus: decision === 'REMOVE' ? 'PUBLISHED' : null,
        });

        if (decision === 'RESTORE') {
          expect(await jobState()).to.deep.equal(job);
          expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(0);
          expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
          expect(emitted(job.id)).to.deep.equal([]);
        } else {
          await eventually(async () => emitted(job.id).length === 2);
          const [suspension, removal] = emitted(job.id);
          const { env: freeze } = suspension;
          const { env: cancel } = removal;
          expect(freeze.correlation_id).to.equal(threshold.correlation_id);
          expect(suspension.correlationId).to.equal(threshold.correlation_id);
          expect(freeze.payload).to.include({
            from_status: 'PUBLISHED',
            to_status: 'SUSPENDED',
            entity_version: job.entityVersion + 1,
            application_effect: 'FREEZE',
            reason_code: 'REPORT_THRESHOLD',
          });
          expect(cancel.correlation_id).to.equal(resolution.correlation_id);
          expect(removal.correlationId).to.equal(resolution.correlation_id);
          expect(cancel.payload).to.include({
            from_status: 'SUSPENDED',
            to_status: 'REMOVED',
            entity_version: job.entityVersion + 2,
            application_effect: 'CANCEL_PRE_APPROVAL',
          });
          expect(await jobState()).to.deep.include({
            status: 'REMOVED',
            version: job.version + 2,
            entityVersion: cancel.payload.entity_version,
            publishedAt: job.publishedAt,
            suspendedFromStatus: null,
          });
          const history = await db.prisma.statusHistory.findMany({
            where: { entityId: job.id },
            orderBy: { occurredAt: 'asc' },
          });
          expect(history).to.have.length(2);
          expect(history[0]).to.deep.include({
            actorRole: 'SYSTEM',
            actorId: null,
            reason: 'REPORT_THRESHOLD',
            correlationId: threshold.correlation_id,
            occurredAt: new Date(freeze.payload.changed_at),
          });
          expect(history[1]).to.deep.include({
            actorRole: role,
            actorId: null,
            reason: resolution.payload.decision,
            correlationId: resolution.correlation_id,
            occurredAt: new Date(cancel.payload.changed_at),
          });
        }
        expect(
          await db.prisma.processedEvent.count({
            where: { eventId: { in: [threshold.event_id, resolution.event_id] } },
          }),
        ).to.equal(2);
      } finally {
        change.restore();
      }
    });
  }

  it('dead-letters malformed E04 directly and logs at ERROR without committing Job writes', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const threshold = reportThreshold(job.id, job.companyId);
    const sensitive = 'fixture-only-private-value';
    const dlq = dlqName(consumerQueueName('job', threshold.type));
    const retryQueues = DEFAULT_RETRY_DELAYS_MS.map((_, index) => retryQueueName('job', index + 1));
    const brokerPublish = moduleRef.get(BrokerConnection).publish as sinon.SinonStub;
    const publishCount = brokerPublish.callCount;

    const error = sinon.spy(Logger.prototype, 'error');
    const before = ackCount;
    try {
      for (const reached_at of [
        '2026-11-15T10:00:00.000900Z',
        '2026-11-15T10:00:00.000100Z',
        null,
      ]) {
        const invalid = {
          ...threshold,
          event_id: randomUUID(),
          payload: {
            ...threshold.payload,
            queue_item_id: randomUUID(),
            reached_at,
            extra: sensitive,
          },
        };
        await publisher.publish(
          EVENTS_EXCHANGE,
          routingKey(invalid.producer, invalid.type),
          Buffer.from(JSON.stringify(invalid)),
          { contentType: 'application/json', deliveryMode: 2, messageId: invalid.event_id },
        );
        await eventually(async () => (await observer.checkQueue(dlq)).messageCount === 1);
        const deadLetter = await observer.get(dlq, { noAck: true });
        expect(deadLetter && JSON.parse(deadLetter.content.toString())).to.deep.equal(invalid);
        expect(deadLetter && deadLetter.properties.headers?.[RETRY_COUNT_HEADER]).to.equal(
          undefined,
        );
        expect(String(error.lastCall.args[0]))
          .to.include('invalid_message')
          .and.include(invalid.event_id)
          .and.not.include(sensitive);
        expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
        expect(await db.prisma.reportRound.count({ where: { jobId: job.id } })).to.equal(0);
        expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(0);
        expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
        expect(
          await db.prisma.processedEvent.count({ where: { eventId: invalid.event_id } }),
        ).to.equal(0);
      }
      expect(error.callCount).to.equal(3);
      expect(ackCount).to.equal(before);
      expect(
        brokerPublish
          .getCalls()
          .slice(publishCount)
          .filter(({ args }) => retryQueues.includes(args[1])),
      ).to.have.length(0);
      expect(emitted(job.id)).to.deep.equal([]);
    } finally {
      error.restore();
    }

    await send(threshold);
    await eventually(async () => emitted(job.id).length === 1);
    expect(emitted(job.id)[0].env.payload.application_effect).to.equal('FREEZE');
  });
});
