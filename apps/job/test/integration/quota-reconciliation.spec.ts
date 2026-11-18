import { randomUUID } from 'node:crypto';
import { createServer, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import sinon from 'sinon';
import { InternalJobsModule } from '../../src/modules/internal-jobs/internal-jobs.module';
import { LifecycleReservationClient } from '../../src/modules/internal-jobs/lifecycle-reservation.client';
import { QuotaReconciliationService } from '../../src/modules/internal-jobs/quota-reconciliation.service';
import { QuotaService } from '../../src/modules/internal-jobs/quota.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { seedJob } from '../support/job-events';

const NOW = new Date();
const AGE = new Date(NOW.getTime() - 16 * 60_000);
const FIFTEEN_MINUTES = 15 * 60_000;
const THIRTY_MINUTES = 30 * 60_000;

const results = (ids: string[], shouldHold: boolean) =>
  ids.map((application_id) => ({ application_id, should_hold_quota: shouldHold }));

function send(response: ServerResponse, body: unknown, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

function barrier() {
  let resolve!: () => void;
  const ready = new Promise<void>((done) => {
    resolve = done;
  });
  return { ready, open: resolve };
}

async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Test barrier timed out')), 5000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

describe('Job quota reconciliation (real PostgreSQL and HTTP)', function () {
  this.timeout(60_000);
  type Respond = (ids: string[], response: ServerResponse) => void | Promise<void>;
  let db: TestDatabase;
  let app: INestApplication;
  let server: Server;
  let worker: QuotaReconciliationService;
  let quota: QuotaService;
  let config: ConfigService;
  let respond: Respond;
  const requests: {
    ids: string[];
    path?: string;
    method?: string;
    authorization?: string;
    correlation?: string;
  }[] = [];

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    server = createServer(async (req, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk);
        const { application_ids } = JSON.parse(Buffer.concat(chunks).toString()) as {
          application_ids: string[];
        };
        requests.push({
          ids: application_ids,
          path: req.url,
          method: req.method,
          authorization: req.headers.authorization,
          correlation: req.headers['x-correlation-id'] as string,
        });
        await respond(application_ids, response);
      } catch {
        response.destroy();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    config = new ConfigService({
      JOB_DATABASE_URL: db.url,
      LIFECYCLE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      LIFECYCLE_SERVICE_SECRET_JOB: 'job-quota-outbound-test-secret-long-enough',
    });
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), InternalJobsModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    app = module.createNestApplication({ logger: false });
    await app.init();
    worker = app.get(QuotaReconciliationService);
    quota = app.get(QuotaService);
  });

  after(async () => {
    try {
      await app?.close();
    } finally {
      if (server) {
        const closed = new Promise<void>((resolve) => server.close(() => resolve()));
        server.closeAllConnections();
        await closed;
      }
      await db?.drop();
    }
  });

  beforeEach(async () => {
    requests.length = 0;
    respond = (ids, response) => send(response, results(ids, true));
    await db.prisma.quotaReservation.deleteMany();
    await db.prisma.job.deleteMany();
  });

  async function seed(
    states: ('RESERVED' | 'CONFIRMED')[],
    dates: { reservedAt?: Date; updatedAt?: Date } = {},
  ) {
    const quotaReserved = states.filter((state) => state === 'RESERVED').length;
    const quotaConfirmed = states.length - quotaReserved;
    const job = await seedJob(db.prisma, 'PUBLISHED', {
      quota: states.length + 1,
      quotaReserved,
      quotaConfirmed,
    });
    const ids = states.map(() => randomUUID()).sort();
    await db.prisma.quotaReservation.createMany({
      data: states.map((status, index) => ({
        jobId: job.id,
        applicationId: ids[index],
        status,
        reservedAt: AGE,
        updatedAt: AGE,
        confirmedAt: status === 'CONFIRMED' ? AGE : null,
        ...dates,
      })),
    });
    return { job, ids };
  }

  const statuses = async (ids: string[]) => {
    const rows = await db.prisma.quotaReservation.findMany({
      where: { applicationId: { in: ids } },
    });
    const states = new Map(rows.map(({ applicationId, status }) => [applicationId, status]));
    return ids.map((id) => states.get(id));
  };

  it('matches shuffled mixed results by ID, includes old RESERVED and CONFIRMED, and skips new or recently changed rows', async () => {
    const { job, ids } = await seed(['RESERVED', 'CONFIRMED', 'RESERVED', 'CONFIRMED']);
    const recent = await seed(['RESERVED'], {
      reservedAt: new Date(NOW.getTime() - FIFTEEN_MINUTES),
      updatedAt: NOW,
    });
    const refreshed = await seed(['CONFIRMED'], { updatedAt: NOW });
    respond = (batch, response) =>
      send(
        response,
        batch
          .map((id) => ({
            application_id: id,
            should_hold_quota: id === ids[0] || id === ids[1],
          }))
          .reverse(),
      );
    await worker.reconcile(NOW);
    expect(requests).to.have.length(1);
    expect(requests[0]).to.include({
      path: '/internal/v1/applications/reservation-check',
      method: 'POST',
    });
    expect(requests[0].authorization).to.match(/^Bearer \S+$/);
    expect(requests[0].correlation).to.be.a('string');
    expect(requests[0].ids).to.deep.equal(ids);
    expect(await statuses(ids)).to.deep.equal(['RESERVED', 'CONFIRMED', 'RELEASED', 'RELEASED']);
    expect(await statuses([...recent.ids, ...refreshed.ids])).to.deep.equal([
      'RESERVED',
      'CONFIRMED',
    ]);
    const released = await db.prisma.quotaReservation.findUniqueOrThrow({
      where: { applicationId: ids[3] },
    });
    expect(released).to.include({ status: 'RELEASED', releaseReason: 'RECONCILIATION' });
    expect(released.confirmedAt).to.deep.equal(AGE);
    expect(released.releasedAt).to.be.instanceOf(Date);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.include({
      quotaReserved: 1,
      quotaConfirmed: 1,
      version: job.version,
      entityVersion: job.entityVersion,
      status: job.status,
    });
    await worker.reconcile(NOW);
    expect(requests[1].ids).to.deep.equal(ids.slice(0, 2));
    expect(
      await db.prisma.quotaReservation.findUniqueOrThrow({ where: { applicationId: ids[3] } }),
    ).to.deep.equal(released);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
    expect(await db.prisma.statusHistory.count()).to.equal(0);
  });

  it('visits more than 500 candidates once, in bounded batches', async () => {
    const { job, ids } = await seed(Array(502).fill('RESERVED'));
    respond = (batch, response) =>
      send(
        response,
        batch.map((id) => ({
          application_id: id,
          should_hold_quota: id !== ids[0] && id !== ids[501],
        })),
      );
    await worker.reconcile(NOW);
    expect(requests.map(({ ids }) => ids.length)).to.deep.equal([500, 2]);
    expect(requests.flatMap((request) => request.ids)).to.deep.equal(ids);
    expect(await statuses([ids[0], ids[1], ids[501]])).to.deep.equal([
      'RELEASED',
      'RESERVED',
      'RELEASED',
    ]);
    expect(
      (await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).quotaReserved,
    ).to.equal(500);
  });

  for (const [name, badResponse] of Object.entries<Respond>({
    'an invalid JSON body': (_, response) => {
      response.end('{');
    },
    'a non-array body': (_, response) => send(response, { data: [] }),
    'an incomplete batch': ([first], response) => send(response, results([first], false)),
    'a mismatched application ID': ([first], response) =>
      send(response, results([first, randomUUID()], false)),
    'a duplicated application ID': ([first], response) =>
      send(response, results([first, first], false)),
    'a non-boolean decision': (ids, response) =>
      send(response, [
        ...results(ids.slice(0, 1), false),
        { application_id: ids[1], should_hold_quota: 'false' },
      ]),
    'an oversized response': (_, response) => {
      response.end(' '.repeat(130 * 1024));
    },
  })) {
    it(`preserves the whole batch for ${name} and releases only after a later valid response`, async () => {
      const { ids } = await seed(['RESERVED', 'CONFIRMED']);
      respond = badResponse;
      await worker.reconcile(NOW);
      expect(await statuses(ids)).to.deep.equal(['RESERVED', 'CONFIRMED']);
      respond = (batch, response) => send(response, results(batch, false));
      await worker.reconcile(NOW);
      expect(await statuses(ids)).to.deep.equal(['RELEASED', 'RELEASED']);
    });
  }

  for (const [name, fail] of Object.entries<Respond>({
    '503': (_, response) => send(response, { upstream_error: true }, 503),
    'a disconnected socket': (_, response) => {
      response.destroy();
    },
    'a timeout': () => undefined,
  })) {
    it(`preserves reservations after ${name} and retries on a later run`, async () => {
      const { ids } = await seed(['RESERVED']);
      respond = fail;
      await worker.reconcile(NOW);
      expect(requests).to.have.length(3);
      expect(new Set(requests.map((request) => request.correlation)).size).to.equal(1);
      expect(await statuses(ids)).to.deep.equal(['RESERVED']);
      respond = (batch, response) => send(response, results(batch, false));
      await worker.reconcile(NOW);
      expect(await statuses(ids)).to.deep.equal(['RELEASED']);
    });
  }

  it('coalesces overlapping runs and skips stale false observations after reserve retry, confirm or release', async () => {
    const { job, ids } = await seed(['RESERVED', 'RESERVED', 'RESERVED', 'RESERVED']);
    const entered = barrier();
    const answer = barrier();
    respond = async (batch, response) => {
      entered.open();
      await answer.ready;
      send(response, results(batch, false));
    };
    const first = worker.reconcile(NOW);
    try {
      await bounded(entered.ready);
      expect(worker.reconcile(NOW)).to.equal(first);
      expect(requests).to.have.length(1);
      await quota.reserve(job.id, ids[0]);
      await quota.confirm(job.id, ids[1]);
      await quota.release(job.id, ids[2], 'API_RELEASE');
    } finally {
      answer.open();
      await first;
    }
    expect(await statuses(ids)).to.deep.equal(['RESERVED', 'CONFIRMED', 'RELEASED', 'RELEASED']);
    expect(
      (await db.prisma.quotaReservation.findUniqueOrThrow({ where: { applicationId: ids[2] } }))
        .releaseReason,
    ).to.equal('API_RELEASE');
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.include({
      quotaReserved: 1,
      quotaConfirmed: 1,
    });
    respond = (batch, response) => send(response, results(batch, true));
    await worker.reconcile(NOW);
    expect(requests).to.have.length(1);
    await worker.reconcile(new Date(NOW.getTime() + THIRTY_MINUTES));
    expect(requests[1].ids).to.deep.equal(ids.slice(0, 2));
  });

  it('ignores a false observation from before re-reserve and reconciles the new hold after it ages', async () => {
    const {
      job,
      ids: [applicationId],
    } = await seed(['RESERVED']);
    const entered = barrier();
    const answer = barrier();
    respond = async (batch, response) => {
      entered.open();
      await answer.ready;
      send(response, results(batch, false));
    };
    const first = worker.reconcile(NOW);
    try {
      await bounded(entered.ready);
      await quota.release(job.id, applicationId, 'API_RELEASE');
      await quota.reserve(job.id, applicationId);
    } finally {
      answer.open();
      await first;
    }
    expect(requests.map(({ ids }) => ids)).to.deep.equal([[applicationId]]);
    expect(await statuses([applicationId])).to.deep.equal(['RESERVED']);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.include({
      quotaReserved: 1,
      quotaConfirmed: 0,
    });

    respond = (batch, response) => send(response, results(batch, false));
    await worker.reconcile(NOW);
    expect(requests).to.have.length(1);
    const later = new Date(NOW.getTime() + THIRTY_MINUTES);
    await worker.reconcile(later);
    expect(requests.map(({ ids }) => ids)).to.deep.equal([[applicationId], [applicationId]]);
    const released = await db.prisma.quotaReservation.findUniqueOrThrow({
      where: { applicationId },
    });
    expect(released).to.include({ status: 'RELEASED', releaseReason: 'RECONCILIATION' });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.include({
      quotaReserved: 0,
      quotaConfirmed: 0,
      status: job.status,
      version: job.version,
      entityVersion: job.entityVersion,
    });
    await worker.reconcile(later);
    expect(requests).to.have.length(2);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
    expect(await db.prisma.statusHistory.count()).to.equal(0);
  });

  it('commits a single release when two scheduler instances see the same old reservation', async () => {
    const { job, ids } = await seed(['CONFIRMED']);
    const replica = new QuotaReconciliationService(
      app.get(PrismaService),
      app.get(LifecycleReservationClient),
      quota,
    );
    const bothRequested = barrier();
    const answer = barrier();
    respond = async (batch, response) => {
      if (requests.length === 2) bothRequested.open();
      await answer.ready;
      send(response, results(batch, false));
    };
    const runs = Promise.all([worker.reconcile(NOW), replica.reconcile(NOW)]);
    try {
      await bounded(bothRequested.ready);
    } finally {
      answer.open();
      await runs;
    }
    expect(requests.map((request) => request.ids)).to.deep.equal([ids, ids]);
    expect(await statuses(ids)).to.deep.equal(['RELEASED']);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.include({
      quotaReserved: 0,
      quotaConfirmed: 0,
    });
    await worker.reconcile(NOW);
    expect(requests).to.have.length(2);
  });

  it('schedules at 30-minute intervals and cancels the timer on shutdown', async () => {
    const clock = sinon.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const scheduler = new QuotaReconciliationService(
      app.get(PrismaService),
      app.get(LifecycleReservationClient),
      quota,
    );
    const reconcile = sinon.stub(scheduler, 'reconcile').resolves();
    try {
      scheduler.onApplicationBootstrap();
      clock.tick(THIRTY_MINUTES - 1);
      expect(reconcile.callCount).to.equal(0);
      clock.tick(1);
      clock.tick(THIRTY_MINUTES);
      expect(reconcile.callCount).to.equal(2);
      await scheduler.onModuleDestroy();
      clock.tick(THIRTY_MINUTES);
      expect(reconcile.callCount).to.equal(2);
    } finally {
      await scheduler.onModuleDestroy();
      clock.restore();
    }
  });
});
