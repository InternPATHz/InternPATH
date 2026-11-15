import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BrokerConnection,
  OutboxRelay,
  PgRelayDb,
  RELAY_FACTORY,
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
import { jobVerified, seedJob } from '../support/job-events';
import { eventually } from '../support/wait';

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
          where: { entityId: env.payload.job_id, toStatus: env.payload.to_status },
        });
        expect(marker).to.equal(1);
        expect(history).to.equal(1);
        expect(
          (await db.prisma.job.findUniqueOrThrow({ where: { id: env.payload.job_id } }))
            .entityVersion,
        ).to.equal(env.payload.entity_version);
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

  const send = (env: ReturnType<typeof jobVerified>, retryCount?: number) => {
    incoming.set(env.payload.job_id, env.event_id);
    return publisher.publish(
      EVENTS_EXCHANGE,
      routingKey('verification', 'JobVerified'),
      Buffer.from(JSON.stringify(env)),
      {
        contentType: 'application/json',
        deliveryMode: 2,
        messageId: env.event_id,
        headers: {
          'x-correlation-id': env.correlation_id,
          ...(retryCount === undefined ? {} : { 'x-retry-count': retryCount }),
        },
      },
    );
  };
  const emitted = (id: string) => received.filter((r) => r.env.payload.job_id === id);

  it('all six independent E02 decisions persist and publish typed E03 with the expected routing/correlation', async () => {
    const cases = [
      ['APPROVE', 'VERIFYING', 'PUBLISHED'],
      ['PENDING_REVIEW', 'VERIFYING', 'PENDING_REVIEW'],
      ['AUTO_REJECT', 'VERIFYING', 'AUTO_REJECTED'],
      ['APPEAL_ACCEPTED', 'AUTO_REJECTED', 'PENDING_REVIEW'],
      ['ADMIN_APPROVE', 'PENDING_REVIEW', 'PUBLISHED'],
      ['ADMIN_REJECT', 'PENDING_REVIEW', 'ADMIN_REJECTED'],
    ] as const;
    for (const [decision, from, to] of cases) {
      const job = await seedJob(db.prisma, from);
      const env = jobVerified(job.id, job.currentSubmissionId!, decision);
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
      });
      expect(actual.env.payload).to.deep.equal(stored.payload);
      expect(actual.messageId).to.equal(stored.id);
      expect(actual.correlationId).to.equal(env.correlation_id);
    }
    expect(visibilityChecks).to.be.at.least(6);
  });

  it('duplicate IDs and stale distinct IDs ACK without extra status/history/outbox writes', async () => {
    const job = await seedJob(db.prisma);
    const env = jobVerified(job.id, job.currentSubmissionId!);
    await send(env);
    await eventually(async () => emitted(job.id).length > 0);
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
  });

  it('failure after E03 insertion rolls back every write, then the real retry queue recovers and publishes E03', async () => {
    const job = await seedJob(db.prisma);
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

  it('a contract-blocked RESTORE is dead-lettered at retry exhaustion without partial state or a marker', async () => {
    const job = await seedJob(db.prisma, 'SUSPENDED', { suspendedFromStatus: 'PUBLISHED' });
    const env = jobVerified(job.id, job.currentSubmissionId!, 'RESTORE');
    await send(env, 3);
    let receivedId: string | undefined;
    await eventually(async () => {
      const message = await observer.get('job.JobVerified.dlq', { noAck: true });
      if (!message) return false;
      receivedId = JSON.parse(message.content.toString()).event_id;
      return true;
    });
    expect(receivedId).to.equal(env.event_id);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
    expect(await db.prisma.processedEvent.count({ where: { eventId: env.event_id } })).to.equal(0);
    expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
    expect(emitted(job.id)).to.have.length(0);
  });
});
