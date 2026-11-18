import { randomUUID } from 'node:crypto';
import { BrokerConnection, retryQueueName } from '@internpath/common';
import { EVENTS_EXCHANGE, routingKey } from '@internpath/contracts';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { expect } from 'chai';
import sinon from 'sinon';
import { JobModule } from '../../src/job.module';
import { createBrokerSandboxOrSkip, type BrokerSandbox } from '../support/broker';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import {
  DELETION_QUEUE,
  anonymizedState,
  deletionMarker,
  deletionRequested,
  seedDeletionFixture,
} from '../support/user-deletion';
import { eventually } from '../support/wait';

describe('Job E15 (real RabbitMQ and PostgreSQL)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let isolated: BrokerSandbox;
  let moduleRef: TestingModule;
  let publisher: BrokerConnection;
  let observer: Awaited<ReturnType<BrokerConnection['createChannel']>>;
  let publish: sinon.SinonSpy;
  let sandbox: sinon.SinonSandbox;
  const outboundQueue = `job_it_${randomUUID()}`;
  const acknowledgements: sinon.SinonSpy[] = [];
  const ackCount = () => acknowledgements.reduce((sum, spy) => sum + spy.callCount, 0);

  before(async function () {
    await dbReachableOrSkip(this);
    isolated = await createBrokerSandboxOrSkip(this);
    db = await createTestDatabase();
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
      .compile();
    sandbox = sinon.createSandbox();
    const broker = moduleRef.get(BrokerConnection);
    const create = broker.createChannel.bind(broker);
    sandbox.stub(broker, 'createChannel').callsFake(async () => {
      const channel = await create();
      acknowledgements.push(sandbox.spy(channel, 'ack'));
      return channel;
    });
    publish = sandbox.spy(broker, 'publish');
    await moduleRef.init();
    publisher = new BrokerConnection({ url: isolated.url });
    await publisher.connect();
    observer = await publisher.createChannel();
    await observer.assertQueue(outboundQueue, { durable: false });
    await observer.bindQueue(outboundQueue, EVENTS_EXCHANGE, routingKey('job', 'JobStatusChanged'));
  });

  after(async () => {
    try {
      await moduleRef?.close();
    } finally {
      try {
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

  const send = (event: ReturnType<typeof deletionRequested>) =>
    publisher.publish(
      EVENTS_EXCHANGE,
      routingKey(event.producer, event.type),
      Buffer.from(JSON.stringify(event)),
      { contentType: 'application/json', deliveryMode: 2, messageId: event.event_id },
    );

  async function expectNoE03() {
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
    expect((await observer.checkQueue(outboundQueue)).messageCount).to.equal(0);
    expect(
      publish.getCalls().filter(({ args }) => args[1] === routingKey('job', 'JobStatusChanged')),
    ).to.have.length(0);
  }

  it('consumes Identity E15, ACKs duplicates, and records a non-matching event as processed', async () => {
    const event = deletionRequested();
    const noMatch = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, event.payload.user_id);
    const expected = anonymizedState(await fixture.read(), event.payload);
    const before = ackCount();
    expect((await observer.checkQueue(DELETION_QUEUE)).consumerCount).to.equal(1);

    await send(event);
    await eventually(async () => ackCount() === before + 1);
    expect(await fixture.read()).to.deep.equal(expected);
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);

    await send(event);
    await send(noMatch);
    await eventually(async () => ackCount() === before + 3);
    expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
    expect(await deletionMarker(db.prisma, noMatch.event_id)).to.equal(1);
    expect(await fixture.read()).to.deep.equal(expected);
    await expectNoE03();
  });

  it('rolls back on a database error and completes redelivery through the retry queue', async () => {
    const event = deletionRequested();
    const fixture = await seedDeletionFixture(db.prisma, event.payload.user_id);
    const before = await fixture.read();
    const startingAcks = ackCount();
    try {
      // The sequence lets this disposable test fail once even though its first transaction rolls back.
      await db.prisma.$executeRaw`CREATE SEQUENCE e15_test_attempts`;
      await db.prisma.$executeRaw`
        CREATE FUNCTION e15_test_fail_once() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF nextval('e15_test_attempts') = 1 THEN
            RAISE EXCEPTION 'E15 test transient failure' USING ERRCODE = '40001';
          END IF;
          RETURN NEW;
        END;
        $$
      `;
      await db.prisma.$executeRaw`
        CREATE TRIGGER e15_test_fail_once BEFORE UPDATE OF submitted_by ON job_submissions
        FOR EACH ROW EXECUTE FUNCTION e15_test_fail_once()
      `;
      await send(event);
      await eventually(async () => ackCount() === startingAcks + 1);
      expect(
        publish
          .getCalls()
          .filter(
            ({ args }) =>
              args[1] === retryQueueName('job', 1) && args[3]?.messageId === event.event_id,
          ),
      ).to.have.length(1);
      expect(await deletionMarker(db.prisma, event.event_id)).to.equal(0);
      expect(await fixture.read()).to.deep.equal(before);
      await expectNoE03();

      await eventually(async () => ackCount() === startingAcks + 2, 15_000);
      expect(await deletionMarker(db.prisma, event.event_id)).to.equal(1);
      expect(await fixture.read()).to.deep.equal(anonymizedState(before, event.payload));
      const [attempts] = await db.prisma.$queryRaw<Array<{ last_value: bigint }>>`
        SELECT last_value FROM e15_test_attempts
      `;
      expect(attempts.last_value).to.equal(2n);
      await expectNoE03();
    } finally {
      await db.prisma.$executeRaw`DROP TRIGGER IF EXISTS e15_test_fail_once ON job_submissions`;
      await db.prisma.$executeRaw`DROP FUNCTION IF EXISTS e15_test_fail_once()`;
      await db.prisma.$executeRaw`DROP SEQUENCE IF EXISTS e15_test_attempts`;
    }
  });
});
