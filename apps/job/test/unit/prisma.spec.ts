import { Socket } from 'node:net';
import { Injectable, Module, type INestApplication, type Type } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, type TestingModule } from '@nestjs/testing';
import {
  HealthController,
  configureApp,
  type OutboxTx,
  type ProcessedEventsTx,
} from '@internpath/common';
import { expect } from 'chai';
import sinon from 'sinon';
import { PrismaClient, type Prisma } from '../../generated/client';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import type { Tx } from '../../src/prisma/types';

// Deliberately unreachable, non-secret values: none of these tests may connect.
const DATABASE_URL = 'postgresql://job_unit@127.0.0.1:1/job_unit';
const DIRECT_URL = 'postgresql://job_unit@127.0.0.1:2/job_unit_direct';

@Injectable()
class PrismaConsumer {
  constructor(readonly prisma: PrismaService) {}
}

// Sibling module intentionally does not import PrismaModule: verifies @Global exports.
@Module({ providers: [PrismaConsumer] })
class ConsumerModule {}

/** Reload the module decorator with each flag, restoring the process and module cache. */
async function appModule(disableInfra: string | undefined): Promise<Type<unknown>> {
  const id = require.resolve('../../src/app.module');
  const cached = require.cache[id];
  const previous = process.env.DISABLE_INFRA;
  try {
    if (disableInfra === undefined) delete process.env.DISABLE_INFRA;
    else process.env.DISABLE_INFRA = disableInfra;
    delete require.cache[id];
    return (await import('../../src/app.module')).AppModule;
  } finally {
    if (previous === undefined) delete process.env.DISABLE_INFRA;
    else process.env.DISABLE_INFRA = previous;
    if (cached) require.cache[id] = cached;
    else delete require.cache[id];
  }
}

describe('Job PrismaModule', () => {
  let sandbox: sinon.SinonSandbox;
  let moduleRef: TestingModule | undefined;
  let config: ConfigService;
  let service: PrismaService;
  let connect: sinon.SinonSpy;
  let disconnect: sinon.SinonStub;
  let network: sinon.SinonStub;
  let configGet: sinon.SinonSpy;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();
    connect = sandbox.spy(PrismaClient.prototype, '$connect');
    disconnect = sandbox.stub(PrismaClient.prototype, '$disconnect').resolves();
    network = sandbox
      .stub(Socket.prototype, 'connect')
      .throws(new Error('Unexpected network access'));
    config = new ConfigService({ JOB_DATABASE_URL: DATABASE_URL, JOB_DIRECT_URL: DIRECT_URL });
    configGet = sandbox.spy(config, 'get');
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        PrismaModule,
        ConsumerModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    service = moduleRef.get(PrismaService);
  });

  afterEach(async () => {
    try {
      await moduleRef?.close();
    } finally {
      moduleRef = undefined;
      sandbox.restore();
    }
  });

  it('resolves one globally exported PrismaService through Nest dependency injection', () => {
    expect(service.constructor === PrismaService).to.equal(true);
    expect(moduleRef!.get(PrismaConsumer).prisma === service).to.equal(true);
    expect(moduleRef!.get(PrismaService) === service).to.equal(true);
  });

  it('uses JOB_DATABASE_URL rather than the direct migration URL, with established transaction timeouts', () => {
    // Inspect actual constructed-client configuration, not source text or real credentials.
    const runtime = service as unknown as {
      _engineConfig: {
        overrideDatasources: { db: { url: string } };
        transactionOptions: { maxWait: number; timeout: number };
      };
    };
    expect(configGet.calledWith('JOB_DATABASE_URL')).to.equal(true);
    expect(configGet.calledWith('JOB_DIRECT_URL')).to.equal(false);
    expect(runtime._engineConfig.overrideDatasources.db.url).to.equal(DATABASE_URL);
    expect(runtime._engineConfig.transactionOptions).to.include({
      maxWait: 10_000,
      timeout: 30_000,
    });
  });

  it('extends the Job-specific generated client and exposes its Job model delegates', () => {
    // Prisma returns a proxy with Object.prototype, so instanceof is unreliable.
    expect(Object.getPrototypeOf(PrismaService.prototype) === PrismaClient.prototype).to.equal(
      true,
    );
    expect(service.job.findMany).to.be.a('function');
    expect(service.jobSubmission.create).to.be.a('function');
    expect(service.quotaReservation.create).to.be.a('function');
  });

  it('does not eagerly connect during construction or module initialization', async () => {
    expect(connect.callCount).to.equal(0);
    await moduleRef!.init();
    expect(connect.callCount).to.equal(0);
    expect(network.callCount).to.equal(0);
  });

  it('awaits $disconnect when Nest closes the module', async () => {
    let finishDisconnect!: () => void;
    disconnect.returns(
      new Promise<void>((resolve) => {
        finishDisconnect = resolve;
      }),
    );
    let closed = false;
    const closing = moduleRef!.close().then(() => {
      closed = true;
    });
    try {
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(disconnect.callCount).to.equal(1);
      expect(closed).to.equal(false);
    } finally {
      finishDisconnect();
      await closing;
      moduleRef = undefined;
    }
    expect(closed).to.equal(true);
  });

  it('keeps Tx assignable to the generated transaction and shared messaging interfaces', () => {
    // These assignments are also checked by ts-node and the explicit no-emit TS check.
    const generatedToTx = (tx: Prisma.TransactionClient): Tx => tx;
    const txToGenerated = (tx: Tx): Prisma.TransactionClient => tx;
    const txToShared = (tx: Tx): OutboxTx & ProcessedEventsTx => tx;
    const tx: Tx = service;
    expect(generatedToTx(tx) === tx).to.equal(true);
    expect(txToGenerated(tx) === tx).to.equal(true);
    expect(Object.is(txToShared(tx), tx)).to.equal(true);
  });
});

describe('Job AppModule infrastructure selection', () => {
  for (const flag of [undefined, 'false', 'true']) {
    it(`initializes without network access with DISABLE_INFRA=${String(flag)}, with the expected Prisma provider`, async () => {
      const sandbox = sinon.createSandbox();
      const network = sandbox
        .stub(Socket.prototype, 'connect')
        .throws(new Error('Unexpected network access'));
      const connect = sandbox.spy(PrismaClient.prototype, '$connect');
      let moduleRef: TestingModule | undefined;
      let app: INestApplication | undefined;
      try {
        moduleRef = await Test.createTestingModule({ imports: [await appModule(flag)] })
          .overrideProvider(ConfigService)
          .useValue(new ConfigService({ JOB_DATABASE_URL: DATABASE_URL }))

          .compile();
        app = moduleRef.createNestApplication();
        configureApp(app);
        await app.init();
        expect(app.get(ConfigService).constructor === ConfigService).to.equal(true);
        expect(app.get(HealthController).health()).to.deep.equal({ status: 'ok', service: 'job' });
        if (flag === 'true') {
          expect(() => app!.get(PrismaService)).to.throw();
        } else {
          expect(app.get(PrismaService).constructor === PrismaService).to.equal(true);
        }
        expect(connect.callCount).to.equal(0);
        expect(network.callCount).to.equal(0);
      } finally {
        try {
          if (app) await app.close();
          else await moduleRef?.close();
        } finally {
          sandbox.restore();
        }
      }
    });
  }
});
