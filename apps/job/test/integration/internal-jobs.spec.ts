import { createHmac, randomUUID } from 'node:crypto';
import { configureApp, signServiceToken } from '@internpath/common';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import request from 'supertest';
import { InternalJobsModule } from '../../src/modules/internal-jobs/internal-jobs.module';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { seedJob } from '../support/job-events';

const secret = 'job-quota-inbound-test-secret-long-enough';
const token = () => signServiceToken({ issuer: 'lifecycle', audience: 'job', secret });
const path = (id: string) => `/internal/v1/jobs/${id}`;

function expiredToken(): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const header = encode({ alg: 'HS256', typ: 'service' });
  const claims = encode({
    iss: 'lifecycle',
    aud: 'job',
    iat: now - 301,
    exp: now - 1,
    jti: randomUUID(),
  });
  const value = `${header}.${claims}`;
  return `${value}.${createHmac('sha256', secret).update(value).digest('base64url')}`;
}

describe('Internal Job API (HTTP and real PostgreSQL)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let app: INestApplication;
  let config: ConfigService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    config = new ConfigService({ JOB_DATABASE_URL: db.url, JOB_SERVICE_SECRET_LIFECYCLE: secret });
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), InternalJobsModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    app = module.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  after(async () => {
    try {
      await app?.close();
    } finally {
      await db?.drop();
    }
  });

  const http = () => request(app.getHttpServer());
  const get = (id: string) => http().get(path(id)).auth(token(), { type: 'bearer' });
  const post = (jobId: string, operation: string, applicationId: string, extra = {}) =>
    http()
      .post(`${path(jobId)}/quota/${operation}`)
      .auth(token(), { type: 'bearer' })
      .send({ application_id: applicationId, ...extra });
  const quota = (id: string) =>
    db.prisma.job.findUniqueOrThrow({
      where: { id },
      select: {
        quotaReserved: true,
        quotaConfirmed: true,
        entityVersion: true,
        version: true,
        status: true,
      },
    });
  const reservation = (applicationId: string) =>
    db.prisma.quotaReservation.findUnique({ where: { applicationId } });
  const expectCounters = async (id: string, quotaReserved: number, quotaConfirmed: number) => {
    expect(await quota(id)).to.deep.equal({
      quotaReserved,
      quotaConfirmed,
      entityVersion: 10,
      version: 4,
      status: 'PUBLISHED',
    });
  };

  it('returns only the contract fields, including title, date and quota from both persisted counters', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', {
      jobTitle: 'Lifecycle snapshot title',
      quotaReserved: 1,
      quotaConfirmed: 2,
      contactNotes: 'private',
    });
    const before = await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    await get(job.id.toUpperCase()).expect(200, {
      job_id: job.id,
      company_id: job.companyId,
      status: 'PUBLISHED',
      quota: 5,
      quota_available: 2,
      job_title: 'Lifecycle snapshot title',
      category: 'TECH_IT',
      target_majors: ['CS'],
      application_deadline: '2026-12-01',
      entity_version: 10,
    });
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(before);
    await http()
      .get('/v1' + path(job.id))
      .auth(token(), { type: 'bearer' })
      .expect(404);
  });

  it('returns complete non-PUBLISHED jobs and hides both incomplete and complete drafts', async () => {
    const closed = await seedJob(db.prisma, 'CLOSED');
    const complete = await seedJob(db.prisma, 'DRAFT');
    const incompleteId = randomUUID();
    await db.prisma.$executeRaw`
      INSERT INTO jobs (id, company_id, created_by, status, entity_version, version)
      VALUES (${incompleteId}::uuid, ${randomUUID()}::uuid, ${randomUUID()}::uuid, 'DRAFT', 1, 1)
    `;
    expect((await get(closed.id).expect(200)).body.status).to.equal('CLOSED');
    for (const id of [complete.id, incompleteId, randomUUID()]) {
      expect((await get(id).expect(404)).body.error.code).to.equal('NOT_FOUND');
    }
  });

  it('guards every endpoint and rejects invalid, expired, wrong-issuer, wrong-audience and wrong-signature tokens', async () => {
    const id = randomUUID();
    await http().get(path(id)).expect(401);
    for (const action of ['reserve', 'confirm', 'release']) {
      await http()
        .post(`${path(id)}/quota/${action}`)
        .send({ application_id: randomUUID() })
        .expect(401);
    }
    const make = (overrides = {}) =>
      signServiceToken({ issuer: 'lifecycle', audience: 'job', secret, ...overrides });
    for (const bad of [
      'malformed',
      expiredToken(),
      make({ issuer: 'identity' }),
      make({ audience: 'lifecycle' }),
      make({ secret: 'x'.repeat(32) }),
    ]) {
      const { body } = await http().get(path(id)).auth(bad, { type: 'bearer' }).expect(401);
      expect(body.error.code).to.equal('UNAUTHENTICATED');
      expect(body.error.correlation_id).to.be.a('string');
    }
    const original = config.get('JOB_SERVICE_SECRET_LIFECYCLE');
    config.set('JOB_SERVICE_SECRET_LIFECYCLE', 'short');
    try {
      expect((await get(id).expect(503)).body.error.code).to.equal('AUTH_NOT_CONFIGURED');
    } finally {
      config.set('JOB_SERVICE_SECRET_LIFECYCLE', original);
    }
  });

  it('validates route and request IDs, body fields and release reason', async () => {
    const id = randomUUID();
    expect((await get('bad-uuid').expect(400)).body.error.code).to.equal('VALIDATION_FAILED');
    await post('bad-uuid', 'reserve', randomUUID()).expect(400);
    await post(id, 'reserve', 'bad-uuid').expect(400);
    await post(id, 'confirm', randomUUID(), { unexpected: true }).expect(400);
    await post(id, 'release', randomUUID()).expect(400);
    await post(id, 'release', randomUUID(), { reason: ' ' }).expect(400);
  });

  it('reserves or returns QUOTA_FULL, and retries an active ID even when the job is full', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200, { reserved: true });
    const first = await reservation(id);
    await post(job.id, 'reserve', id.toUpperCase()).expect(200, { reserved: true });
    const retry = await reservation(id);
    expect(retry).to.include({ jobId: job.id, status: 'RESERVED' });
    expect(retry?.reservedAt).to.deep.equal(first?.reservedAt);
    const overflow = randomUUID();
    expect((await post(job.id, 'reserve', overflow).expect(409)).body.error.code).to.equal(
      'QUOTA_FULL',
    );
    expect(await reservation(overflow)).to.equal(null);
    await expectCounters(job.id, 1, 0);
    expect((await get(job.id).expect(200)).body.quota_available).to.equal(0);
  });

  it('serializes concurrent claims for the final slot on one Job', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => post(job.id, 'reserve', randomUUID())),
    );
    expect(responses.map(({ status }) => status).sort()).to.deep.equal([
      200, 409, 409, 409, 409, 409,
    ]);
    expect(
      responses.filter(({ status }) => status === 409).map(({ body }) => body.error.code),
    ).to.deep.equal(Array(5).fill('QUOTA_FULL'));
    await expectCounters(job.id, 1, 0);
    expect(await db.prisma.quotaReservation.count({ where: { jobId: job.id } })).to.equal(1);
  });

  it('arbitrates the same application ID across jobs and rejects confirm and release on the wrong Job', async () => {
    const jobs = await Promise.all([
      seedJob(db.prisma, 'PUBLISHED'),
      seedJob(db.prisma, 'PUBLISHED'),
    ]);
    const id = randomUUID();
    const claim = await Promise.all(jobs.map((job) => post(job.id, 'reserve', id)));
    expect(claim.map(({ status }) => status).sort()).to.deep.equal([200, 409]);
    expect(claim.find(({ status }) => status === 409)?.body.error.code).to.equal('STATE_CONFLICT');
    const owner = (await reservation(id))!.jobId;
    const other = jobs.find((job) => job.id !== owner)!.id;
    await post(other, 'confirm', id).expect(409);
    await post(other, 'release', id, { reason: 'WRONG_JOB' }).expect(409);
    await expectCounters(owner, 1, 0);
    await expectCounters(other, 0, 0);
    await post(owner, 'release', id, { reason: 'RELEASED_BY_OWNER' }).expect(200);
    const released = await reservation(id);
    expect((await post(other, 'reserve', id).expect(409)).body.error.code).to.equal(
      'STATE_CONFLICT',
    );
    expect(await reservation(id)).to.deep.equal(released);
    await expectCounters(owner, 0, 0);
    await expectCounters(other, 0, 0);
  });

  it('confirms exactly once and releases a confirmed reservation while preserving both timestamps', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200);
    await post(job.id, 'confirm', id).expect(204);
    const confirmed = await reservation(id);
    expect(confirmed?.status).to.equal('CONFIRMED');
    expect(confirmed?.confirmedAt).to.be.instanceOf(Date);
    await post(job.id, 'confirm', id).expect(204);
    await post(job.id, 'reserve', id).expect(200, { reserved: true });
    expect(await reservation(id)).to.deep.equal(confirmed);
    await expectCounters(job.id, 0, 1);
    await post(job.id, 'release', id, { reason: 'WITHDRAWN' }).expect(200, {});
    const released = await reservation(id);
    expect(released).to.include({ status: 'RELEASED', releaseReason: 'WITHDRAWN' });
    expect(released?.confirmedAt).to.deep.equal(confirmed?.confirmedAt);
    expect(released?.reservedAt).to.deep.equal(confirmed?.reservedAt);
    expect(released?.releasedAt).to.be.instanceOf(Date);
    await expectCounters(job.id, 0, 0);
  });

  it('releases RESERVED once and treats absent releases as no-ops', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const id = randomUUID();
    const missing = randomUUID();
    await post(job.id, 'release', missing, { reason: 'MISSING' }).expect(200, {});
    await post(randomUUID(), 'release', missing, { reason: 'MISSING_JOB' }).expect(200, {});
    await post(job.id, 'confirm', missing).expect(409);
    await post(job.id, 'reserve', id).expect(200);
    await post(job.id, 'release', id, { reason: 'ORIGINAL' }).expect(200);
    const released = await reservation(id);
    expect(released).to.include({
      status: 'RELEASED',
      releaseReason: 'ORIGINAL',
      confirmedAt: null,
    });
    await post(job.id, 'release', id, { reason: 'LATE_RETRY' }).expect(200);
    await post(job.id, 'confirm', id).expect(409);
    expect(await reservation(id)).to.deep.equal(released);
    expect(await reservation(missing)).to.equal(null);
    await expectCounters(job.id, 0, 0);
  });

  it('re-reserves the same application and starts a new reservation cycle on the original row', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200);
    await post(job.id, 'confirm', id).expect(204);
    await post(job.id, 'release', id, { reason: 'OLD_CYCLE' }).expect(200);
    const old = new Date('2026-11-01T00:00:00Z');
    const released = await db.prisma.quotaReservation.update({
      where: { applicationId: id },
      data: { reservedAt: old, confirmedAt: old, releasedAt: old, updatedAt: old },
    });

    await post(job.id, 'reserve', id).expect(200, { reserved: true });
    const current = (await reservation(id))!;
    expect(current).to.include({
      applicationId: id,
      jobId: job.id,
      status: 'RESERVED',
      confirmedAt: null,
      releasedAt: null,
      releaseReason: null,
    });
    expect(current.createdAt).to.deep.equal(released.createdAt);
    expect(current.reservedAt.getTime()).to.be.greaterThan(released.releasedAt!.getTime());
    expect(current.updatedAt).to.deep.equal(current.reservedAt);
    await expectCounters(job.id, 1, 0);
  });

  it('returns QUOTA_FULL for a released application without changing either the row or Job', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const releasedId = randomUUID();
    const confirmedId = randomUUID();
    await post(job.id, 'reserve', releasedId).expect(200);
    await post(job.id, 'release', releasedId, { reason: 'KEEP_WHEN_FULL' }).expect(200);
    await post(job.id, 'reserve', confirmedId).expect(200);
    await post(job.id, 'confirm', confirmedId).expect(204);
    const releasedBefore = await reservation(releasedId);
    const jobBefore = await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } });

    expect((await post(job.id, 'reserve', releasedId).expect(409)).body.error.code).to.equal(
      'QUOTA_FULL',
    );
    expect(await reservation(releasedId)).to.deep.equal(releasedBefore);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(
      jobBefore,
    );
    await expectCounters(job.id, 0, 1);
  });

  it('returns 200 to both concurrent re-reserves of the same application and consumes one slot', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200);
    await post(job.id, 'release', id, { reason: 'RETRY' }).expect(200);

    await Promise.all([
      post(job.id, 'reserve', id).expect(200, { reserved: true }),
      post(job.id, 'reserve', id).expect(200, { reserved: true }),
    ]);
    expect(await reservation(id)).to.include({ status: 'RESERVED', releasedAt: null });
    expect(await db.prisma.quotaReservation.count({ where: { jobId: job.id } })).to.equal(1);
    await expectCounters(job.id, 1, 0);
  });

  it('gives the last slot to exactly one of two released applications and a new applicant', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of ids.slice(0, 2)) {
      await post(job.id, 'reserve', id).expect(200);
      await post(job.id, 'release', id, { reason: 'COMPETING' }).expect(200);
    }
    const before = await Promise.all(ids.map(reservation));
    const claims = await Promise.all(ids.map((id) => post(job.id, 'reserve', id)));
    expect(claims.map(({ status }) => status).sort()).to.deep.equal([200, 409, 409]);
    for (const [index, response] of claims.entries()) {
      const row = await reservation(ids[index]);
      if (response.status === 200) {
        expect(row).to.include({ status: 'RESERVED', releaseReason: null });
      } else {
        expect(response.body.error.code).to.equal('QUOTA_FULL');
        expect(row).to.deep.equal(before[index]);
      }
    }
    await expectCounters(job.id, 1, 0);
  });

  it('serializes concurrent reserve, confirm and release against the same released application', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200);
    await post(job.id, 'release', id, { reason: 'OLD_CYCLE' }).expect(200);

    const [, confirmation] = await Promise.all([
      post(job.id, 'reserve', id).expect(200, { reserved: true }),
      post(job.id, 'confirm', id),
      post(job.id, 'release', id, { reason: 'CONCURRENT_RELEASE' }).expect(200, {}),
    ]);
    expect(confirmation.status).to.be.oneOf([204, 409]);
    if (confirmation.status === 409) {
      expect(confirmation.body.error.code).to.equal('STATE_CONFLICT');
    }
    const current = (await reservation(id))!;
    await expectCounters(
      job.id,
      Number(current.status === 'RESERVED'),
      Number(current.status === 'CONFIRMED'),
    );
    expect(current.confirmedAt !== null).to.equal(confirmation.status === 204);
    expect(current.releaseReason).to.equal(
      current.status === 'RELEASED' ? 'CONCURRENT_RELEASE' : null,
    );
  });

  it('serializes confirm versus release and preserves the final counts and release metadata', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED');
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200);
    const [confirmation, release] = await Promise.all([
      post(job.id, 'confirm', id),
      post(job.id, 'release', id, { reason: 'RACE' }),
    ]);
    expect(confirmation.status).to.be.oneOf([204, 409]);
    expect(release.status).to.equal(200);
    expect(await reservation(id)).to.include({ status: 'RELEASED', releaseReason: 'RACE' });
    expect((await reservation(id))?.confirmedAt !== null).to.equal(confirmation.status === 204);
    await expectCounters(job.id, 0, 0);
  });

  it('rolls back reservation and counter changes when the Job write fails in each transition', async () => {
    const newJob = await seedJob(db.prisma, 'PUBLISHED');
    const heldJob = await seedJob(db.prisma, 'PUBLISHED');
    const newId = randomUUID();
    const heldId = randomUUID();
    const releasedId = randomUUID();
    await post(heldJob.id, 'reserve', heldId).expect(200);
    await post(newJob.id, 'reserve', releasedId).expect(200);
    await post(newJob.id, 'release', releasedId, { reason: 'BEFORE_FAILURE' }).expect(200);
    const heldBefore = await reservation(heldId);
    const releasedBefore = await reservation(releasedId);
    await db.prisma.$executeRaw`
      CREATE FUNCTION test_reject_quota_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected quota update failure'; END;
      $$
    `;
    await db.prisma.$executeRaw`
      CREATE TRIGGER test_reject_quota_update BEFORE UPDATE OF quota_reserved, quota_confirmed ON jobs
      FOR EACH ROW EXECUTE FUNCTION test_reject_quota_update()
    `;
    try {
      await post(newJob.id, 'reserve', newId).expect(500);
      await post(newJob.id, 'reserve', releasedId).expect(500);
      await post(heldJob.id, 'confirm', heldId).expect(500);
      await post(heldJob.id, 'release', heldId, { reason: 'ROLLBACK' }).expect(500);
      expect(await reservation(newId)).to.equal(null);
      expect(await reservation(releasedId)).to.deep.equal(releasedBefore);
      expect(await reservation(heldId)).to.deep.equal(heldBefore);
      await expectCounters(newJob.id, 0, 0);
      await expectCounters(heldJob.id, 1, 0);
    } finally {
      await db.prisma.$executeRaw`DROP TRIGGER test_reject_quota_update ON jobs`;
      await db.prisma.$executeRaw`DROP FUNCTION test_reject_quota_update()`;
    }
    await post(newJob.id, 'reserve', newId).expect(200);
    await post(newJob.id, 'reserve', releasedId).expect(200);
    await post(heldJob.id, 'confirm', heldId).expect(204);
    await post(heldJob.id, 'release', heldId, { reason: 'RECOVERED' }).expect(200);
  });

  it('preserves capacity and nonnegative CHECKs and writes no Job status history or outbox events', async () => {
    const job = await seedJob(db.prisma, 'PUBLISHED', { quota: 1 });
    const id = randomUUID();
    await post(job.id, 'reserve', id).expect(200);
    for (const invalid of [{ quotaConfirmed: 1 }, { quotaReserved: -1 }]) {
      try {
        await db.prisma.job.update({ where: { id: job.id }, data: invalid });
        expect.fail('Invalid counters were accepted');
      } catch (error) {
        expect(error).to.be.instanceOf(Error);
        expect((error as Error).message).to.match(
          /jobs_quota_(capacity|reserved_nonnegative)_check/,
        );
      }
    }
    await expectCounters(job.id, 1, 0);
    expect(await db.prisma.outboxEvent.count()).to.equal(0);
    expect(await db.prisma.statusHistory.count()).to.equal(0);
  });
});
