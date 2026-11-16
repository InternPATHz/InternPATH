import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  BrokerConnection,
  EventConsumer,
  MESSAGING_OPTIONS,
  type MessagingModuleOptions,
  type Subscription,
} from '@internpath/common';
import { expect } from 'chai';
import sinon from 'sinon';
import { CompanySnapshotService } from '../../src/company/company-snapshot.service';
import { JobModule } from '../../src/job.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { Tx } from '../../src/prisma/types';
import {
  companyEntitlementEvent,
  companyFlagEvent,
  companyStatusEvent,
} from '../support/company-events';

describe('Job company consumer wiring', () => {
  let moduleRef: TestingModule;
  let sandbox: sinon.SinonSandbox;
  let subscribe: sinon.SinonSpy;
  let snapshots: CompanySnapshotService;
  let prisma: { $transaction: sinon.SinonStub };
  let broker: {
    connect: sinon.SinonStub;
    close: sinon.SinonStub;
    publish: sinon.SinonStub;
    onConnected: sinon.SinonStub;
    isConnected: () => boolean;
  };
  const tx = {} as Tx;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    prisma = {
      $transaction: sandbox
        .stub()
        .callsFake(async (fn: (client: Tx) => Promise<unknown>) => fn(tx)),
    };
    broker = {
      connect: sandbox.stub().resolves(),
      close: sandbox.stub().resolves(),
      publish: sandbox.stub(),
      onConnected: sandbox.stub(),
      isConnected: () => false,
    };
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), JobModule],
    })
      .overrideProvider(ConfigService)
      .useValue(new ConfigService())
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .overrideProvider(BrokerConnection)
      .useValue(broker)

      .compile();
    snapshots = moduleRef.get(CompanySnapshotService);
    subscribe = sandbox.spy(moduleRef.get<EventConsumer<Tx>>(EventConsumer), 'subscribe');
    await moduleRef.init();
  });

  afterEach(async () => {
    try {
      await moduleRef?.close();
    } finally {
      sandbox.restore();
    }
  });

  const subscription = (type: string): Subscription<Tx> =>
    subscribe
      .getCalls()
      .map((c) => c.args[0] as Subscription<Tx>)
      .find((s) => s.type === type)!;

  it('registers exactly E05/E06 from Identity and E18 from Verification', () => {
    expect(subscribe.callCount).to.equal(3);
    expect(
      subscribe
        .getCalls()
        .map((c) => ({ type: c.args[0].type, producer: c.args[0].producer }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).to.deep.equal([
      { type: 'CompanyEntitlementChanged', producer: 'identity' },
      { type: 'CompanyFlagChanged', producer: 'verification' },
      { type: 'CompanyStatusChanged', producer: 'identity' },
    ]);
  });

  it('configures consumption only and runs work with the injected Prisma transaction', async () => {
    const options = moduleRef.get<MessagingModuleOptions<Tx>>(MESSAGING_OPTIONS);
    expect(options.service).to.equal('job');
    expect(options.publishes).to.equal(undefined);
    expect(Object.is(moduleRef.get(PrismaService), prisma)).to.equal(true);
    const consumes = options.consumes;
    if (!consumes || !('useFactory' in consumes))
      throw new Error('Expected injected transaction factory');
    const runner = await consumes.useFactory(prisma);
    const work = async (client: Tx) => {
      expect(client === tx).to.equal(true);
      return 'committed';
    };
    expect(await runner.runInTransaction(work)).to.equal('committed');
    sinon.assert.calledOnceWithExactly(prisma.$transaction, work);
    sinon.assert.notCalled(broker.publish);
    sinon.assert.calledOnce(broker.connect);
  });

  for (const [type, method, make] of [
    ['CompanyStatusChanged', 'handleCompanyStatusChanged', companyStatusEvent],
    ['CompanyEntitlementChanged', 'handleCompanyEntitlementChanged', companyEntitlementEvent],
    ['CompanyFlagChanged', 'handleCompanyFlagChanged', companyFlagEvent],
  ] as const) {
    it(`delegates ${type} with the same envelope and transaction`, async () => {
      const handle = sandbox.stub(snapshots, method).resolves();
      const env = make(randomUUID());
      await subscription(type).handler(env, tx);
      expect(handle.callCount).to.equal(1);
      expect(Object.is(handle.firstCall.args[0], env)).to.equal(true);
      expect(Object.is(handle.firstCall.args[1], tx)).to.equal(true);
    });
  }
});
