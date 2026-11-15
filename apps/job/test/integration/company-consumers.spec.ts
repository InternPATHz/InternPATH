import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import { BrokerConnection, RELAY_FACTORY } from '@internpath/common';
import { EVENTS_EXCHANGE, routingKey } from '@internpath/contracts';
import { expect } from 'chai';
import sinon from 'sinon';
import { CompanySnapshotService } from '../../src/company/company-snapshot.service';
import { JobModule } from '../../src/job.module';
import { createBrokerSandboxOrSkip, type BrokerSandbox } from '../support/broker';
import {
  companyEntitlementEvent,
  companyFlagEvent,
  companyStatusEvent,
  type CompanyEvent,
} from '../support/company-events';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { eventually } from '../support/wait';

describe('Job company consumers (real RabbitMQ + PostgreSQL, private test vhost)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let isolated: BrokerSandbox;
  let moduleRef: TestingModule;
  let publisher: BrokerConnection;
  let snapshots: CompanySnapshotService;
  let sandbox: sinon.SinonSandbox;
  const acknowledgements: sinon.SinonSpy[] = [];
  const ackCount = () => acknowledgements.reduce((n, spy) => n + spy.callCount, 0);

  before(async function () {
    await dbReachableOrSkip(this);
    isolated = await createBrokerSandboxOrSkip(this);
    db = await createTestDatabase();
    sandbox = sinon.createSandbox();
    const relay = sandbox.stub().rejects(new Error('Outbound relay must not start in Phase 2A'));
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), JobModule],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JOB_DATABASE_URL: db.url,
          RABBITMQ_URL: isolated.url,
        }),
      )
      .overrideProvider(RELAY_FACTORY)
      .useValue(relay)
      .compile();
    const broker = moduleRef.get(BrokerConnection);
    const create = broker.createChannel.bind(broker);
    sandbox.stub(broker, 'createChannel').callsFake(async () => {
      const channel = await create();
      acknowledgements.push(sandbox.spy(channel, 'ack'));
      return channel;
    });
    snapshots = moduleRef.get(CompanySnapshotService);
    await moduleRef.init();
    expect(acknowledgements).to.have.length(3);
    sinon.assert.notCalled(relay);
    publisher = new BrokerConnection({ url: isolated.url });
    await publisher.connect();
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

  const send = (env: CompanyEvent) =>
    publisher.publish(
      EVENTS_EXCHANGE,
      routingKey(env.producer, env.type),
      Buffer.from(JSON.stringify(env)),
      { contentType: 'application/json', deliveryMode: 2, messageId: env.event_id },
    );
  const state = async (id: string) => ({
    snapshot: await db.prisma.companySnapshot.findUnique({ where: { companyId: id } }),
    entitlement: await db.prisma.companyEntitlement.findUnique({ where: { companyId: id } }),
    flag: await db.prisma.companyFlag.findUnique({ where: { companyId: id } }),
  });
  const markers = (events: CompanyEvent[]) =>
    db.prisma.processedEvent.findMany({
      where: { eventId: { in: events.map((e) => e.event_id) } },
      orderBy: { consumer: 'asc' },
    });

  it('subscribes to all three producers/types and persists the approved mappings', async () => {
    const id = randomUUID();
    const events = [companyStatusEvent(id), companyEntitlementEvent(id), companyFlagEvent(id)];
    const before = ackCount();
    for (const env of events) await send(env);
    await eventually(async () => ackCount() === before + 3);
    const rows = await state(id);
    expect(rows.snapshot).to.include({
      companyId: id,
      name: 'Company v1',
      logoKey: 'companies/logo.png',
      status: 'VERIFIED',
      universityPartner: false,
      verifiedBadge: true,
      entityVersion: 1,
    });
    expect(rows.entitlement).to.include({
      companyId: id,
      featuredEnabled: false,
      fastTrackEnabled: false,
      entityVersion: 1,
    });
    expect(rows.flag).to.include({ companyId: id, underReview: true, entityVersion: 1 });
    const processed = await markers(events);
    expect(processed).to.have.length(3);
    expect(processed.map((row) => row.consumer)).to.deep.equal([
      'job.CompanyEntitlementChanged',
      'job.CompanyFlagChanged',
      'job.CompanyStatusChanged',
    ]);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
    expect(await db.prisma.statusHistory.count()).to.equal(0);
  });

  it('acknowledges repeated event IDs without re-running any snapshot handler', async () => {
    const id = randomUUID();
    const events = [companyStatusEvent(id), companyEntitlementEvent(id), companyFlagEvent(id)];
    const spies = [
      sinon.spy(snapshots, 'handleCompanyStatusChanged'),
      sinon.spy(snapshots, 'handleCompanyEntitlementChanged'),
      sinon.spy(snapshots, 'handleCompanyFlagChanged'),
    ];
    try {
      const before = ackCount();
      for (const env of events) await send(env);
      await eventually(async () => ackCount() === before + 3);
      const original = await state(id);
      for (const env of events) {
        const altered = { ...env, payload: { ...env.payload, entity_version: 99 } } as CompanyEvent;
        await send(altered);
        await send(altered);
      }
      await eventually(async () => ackCount() === before + 9);
      expect(await state(id)).to.deep.equal(original);
      expect(await markers(events)).to.have.length(3);
      for (const spy of spies) expect(spy.callCount).to.equal(1);
    } finally {
      for (const spy of spies) spy.restore();
    }
  });

  it('acks stale/equal versions with new event IDs while preserving all three latest snapshots', async () => {
    const id = randomUUID();
    const latest = [
      companyStatusEvent(id, 3),
      companyEntitlementEvent(id, 3),
      companyFlagEvent(id, 3),
    ];
    const before = ackCount();
    for (const env of latest) await send(env);
    await eventually(async () => ackCount() === before + 3);
    const original = await state(id);
    const old = [
      companyStatusEvent(id, 1),
      companyEntitlementEvent(id, 1),
      companyFlagEvent(id, 1),
    ];
    const equal = [
      companyStatusEvent(id, 3, {
        status: 'SUSPENDED',
        snapshot: { name: 'Must not overwrite', university_partner: true, verified_badge: false },
      }),
      companyEntitlementEvent(id, 3, { featured_enabled: true, fast_track_enabled: false }),
      companyFlagEvent(id, 3, { active: false }),
    ];
    for (const env of [...old, ...equal]) await send(env);
    await eventually(async () => ackCount() === before + 9);
    expect(await state(id)).to.deep.equal(original);
    expect(await markers([...latest, ...old, ...equal])).to.have.length(9);
  });

  it('rolls back a failed delivery and commits its retry through the real retry queue', async () => {
    const id = randomUUID();
    const env = companyStatusEvent(id);
    const original = snapshots.handleCompanyStatusChanged.bind(snapshots);
    let attempts = 0;
    const handle = sinon
      .stub(snapshots, 'handleCompanyStatusChanged')
      .callsFake(async (event, tx) => {
        await original(event, tx);
        attempts++;
        if (attempts === 1) throw new Error('Intentional failure after the snapshot write');
      });
    try {
      const before = ackCount();
      await send(env);
      await eventually(async () => ackCount() === before + 1);
      expect(await db.prisma.companySnapshot.findUnique({ where: { companyId: id } })).to.equal(
        null,
      );
      expect(await markers([env])).to.have.length(0);
      await eventually(async () => ackCount() === before + 2, 15000);
      expect(attempts).to.equal(2);
      expect(
        await db.prisma.companySnapshot.findUniqueOrThrow({ where: { companyId: id } }),
      ).to.include({ entityVersion: 1 });
      expect(await markers([env])).to.have.length(1);
    } finally {
      handle.restore();
    }
  });
});
