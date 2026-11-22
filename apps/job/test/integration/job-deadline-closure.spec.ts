import { BrokerConnection } from '@internpath/common';
import {
  EVENTS_EXCHANGE,
  routingKey,
  type EventEnvelope,
  type JobStatusChangedPayload,
} from '@internpath/contracts';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { expect } from 'chai';
import { JobModule } from '../../src/job.module';
import { JobDeadlineClosureService } from '../../src/status/job-deadline-closure.service';
import { createBrokerSandboxOrSkip, type BrokerSandbox } from '../support/broker';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { seedJob } from '../support/job-events';
import { eventually } from '../support/wait';

const DEADLINE = new Date('2098-11-16T00:00:00.000Z');
const LAST_INSTANT = new Date('2098-11-16T16:59:59.999Z');
const FIRST_EXPIRED_INSTANT = new Date('2098-11-16T17:00:00.000Z');

describe('Automatic Job deadline closure (PostgreSQL and RabbitMQ)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let broker: BrokerSandbox;
  let observer: BrokerConnection;
  let moduleRef: TestingModule;
  let scheduler: JobDeadlineClosureService;
  const events: EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>[] = [];

  before(async function () {
    await dbReachableOrSkip(this);
    broker = await createBrokerSandboxOrSkip(this);
    db = await createTestDatabase();
    observer = new BrokerConnection({ url: broker.url });
    await observer.connect();
    const ch = await observer.createChannel();
    const queue = await ch.assertQueue('', { exclusive: true });
    await ch.bindQueue(queue.queue, EVENTS_EXCHANGE, routingKey('job', 'JobStatusChanged'));
    await ch.consume(queue.queue, (message) => {
      if (!message) return;
      events.push(JSON.parse(message.content.toString()));
      ch.ack(message);
    });
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), JobModule],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JOB_DATABASE_URL: db.url,
          JOB_DIRECT_URL: db.url,
          RABBITMQ_URL: broker.url,
        }),
      )
      .compile();
    await moduleRef.init();
    scheduler = moduleRef.get(JobDeadlineClosureService);
  });

  after(async () => {
    try {
      await moduleRef?.close();
    } finally {
      try {
        await observer?.close();
      } finally {
        try {
          await db?.drop();
        } finally {
          await broker?.drop();
        }
      }
    }
  });

  const jobById = (id: string) => db.prisma.job.findUniqueOrThrow({ where: { id } });
  const historyFor = (id: string) => db.prisma.statusHistory.findMany({ where: { entityId: id } });
  const outboxFor = (id: string) => db.prisma.outboxEvent.findMany({ where: { aggregateId: id } });

  it('closes just after Bangkok midnight and publishes one transactional E03 across repeated runs', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { applicationDeadline: DEADLINE });
    await scheduler.closeExpiredJobs(LAST_INSTANT);
    expect(await jobById(job.id)).to.deep.equal(job);
    expect(await outboxFor(job.id)).to.have.length(0);

    await scheduler.closeExpiredJobs(FIRST_EXPIRED_INSTANT);
    const closed = await jobById(job.id);
    expect(closed).to.include({
      status: 'CLOSED',
      version: job.version + 1,
      entityVersion: job.entityVersion + 1,
    });
    expect(closed.closedAt).to.deep.equal(FIRST_EXPIRED_INSTANT);
    expect(closed.publishedAt).to.deep.equal(job.publishedAt);
    const histories = await historyFor(job.id);
    expect(histories).to.have.length(1);
    expect(histories[0]).to.include({
      entity: 'JOB',
      fromStatus: 'PUBLISHED',
      toStatus: 'CLOSED',
      actorRole: 'SYSTEM',
      actorId: null,
      reason: 'DEADLINE_EXPIRED',
    });
    expect(histories[0].occurredAt).to.deep.equal(FIRST_EXPIRED_INSTANT);

    const payload: JobStatusChangedPayload = {
      job_id: job.id,
      company_id: job.companyId,
      from_status: 'PUBLISHED',
      to_status: 'CLOSED',
      entity_version: closed.entityVersion,
      changed_at: FIRST_EXPIRED_INSTANT.toISOString(),
      application_effect: 'NONE',
    };
    const outbox = await outboxFor(job.id);
    expect(outbox).to.have.length(1);
    expect(outbox[0]).to.include({
      type: 'JobStatusChanged',
      correlationId: histories[0].correlationId,
    });
    expect(outbox[0].payload).to.deep.equal(payload);
    await scheduler.closeExpiredJobs(new Date(FIRST_EXPIRED_INSTANT.getTime() + 30_000));
    await eventually(
      () => Promise.resolve(events.some((event) => event.event_id === outbox[0].id)),
      20_000,
    );
    expect(events.filter((event) => event.payload.job_id === job.id)).to.deep.equal([
      {
        event_id: outbox[0].id,
        type: 'JobStatusChanged',
        version: 1,
        occurred_at: outbox[0].createdAt.toISOString(),
        correlation_id: histories[0].correlationId,
        producer: 'job',
        payload,
      },
    ]);
    expect(await jobById(job.id)).to.deep.equal(closed);
    expect(await historyFor(job.id)).to.have.length(1);
    expect(await outboxFor(job.id)).to.have.length(1);
  });

  it('leaves current and future deadlines and all other job statuses unchanged', async () => {
    const jobs = await Promise.all([
      seedJob(db.prisma, 'PUBLISHED', { applicationDeadline: new Date('2098-11-17') }),
      seedJob(db.prisma, 'PUBLISHED', { applicationDeadline: new Date('2098-11-18') }),
      ...(
        [
          'DRAFT',
          'VERIFYING',
          'PENDING_REVIEW',
          'AUTO_REJECTED',
          'ADMIN_REJECTED',
          'CLOSED',
          'SUSPENDED',
          'REMOVED',
        ] as const
      ).map((status) => seedJob(db.prisma, status, { applicationDeadline: DEADLINE })),
    ]);
    await scheduler.closeExpiredJobs(FIRST_EXPIRED_INSTANT);
    for (const job of jobs) {
      expect(await jobById(job.id)).to.deep.equal(job);
      expect(await historyFor(job.id)).to.have.length(0);
      expect(await outboxFor(job.id)).to.have.length(0);
    }
  });

  it('skips locked rows and concurrent runners close each eligible job exactly once', async () => {
    const locked = await seedJob(db.prisma, 'PUBLISHED', { applicationDeadline: DEADLINE });
    const free = await seedJob(db.prisma, 'PUBLISHED', { applicationDeadline: DEADLINE });
    const race = () =>
      Promise.all([
        scheduler.closeExpiredJobs(FIRST_EXPIRED_INSTANT),
        scheduler.closeExpiredJobs(FIRST_EXPIRED_INSTANT),
      ]);
    await db.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM jobs WHERE id = ${locked.id}::uuid FOR UPDATE`;
      await race();
      expect((await jobById(free.id)).status).to.equal('CLOSED');
      expect((await jobById(locked.id)).status).to.equal('PUBLISHED');
    });
    await race();
    for (const job of [locked, free]) {
      expect(await jobById(job.id)).to.include({
        status: 'CLOSED',
        version: job.version + 1,
        entityVersion: job.entityVersion + 1,
      });
      expect(await historyFor(job.id)).to.have.length(1);
      expect(await outboxFor(job.id)).to.have.length(1);
    }
  });
});
