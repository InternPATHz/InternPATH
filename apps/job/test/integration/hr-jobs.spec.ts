import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { configureApp, OutboxWriter } from '@internpath/common';
import { Global, Module, type INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import sinon from 'sinon';
import request from 'supertest';
import { HrJobsModule } from '../../src/modules/hr-jobs/hr-jobs.module';
import { JobVerificationTimeoutService } from '../../src/status/job-verification-timeout.service';
import { JobVerificationService } from '../../src/status/job-verification.service';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { jobVerified, seedJob } from '../support/job-events';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });

function auth(companyId: string, claims: Record<string, unknown> = {}) {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({
    sub: randomUUID(),
    role: 'COMPANY_HR',
    company_id: companyId,
    company_role: 'OWNER',
    iat: now,
    exp: now + 3600,
    jti: randomUUID(),
    ...claims,
  })}`;
  return {
    Authorization: `Bearer ${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`,
  };
}

@Global()
@Module({ providers: [OutboxWriter], exports: [OutboxWriter] })
class TestOutboxModule {}

describe('HR Job API', function () {
  this.timeout(60_000);
  const companyId = randomUUID();
  const otherCompanyId = randomUUID();
  const owner = auth(companyId);
  const base = '/v1/hr/jobs';
  let db: TestDatabase;
  let app: INestApplication;
  let tagId: string;
  let replacementTagId: string;
  let inactiveTagId: string;
  const http = () => request(app.getHttpServer());
  const document = () => ({
    category: 'TECH_IT',
    job_title: 'Frontend Intern',
    description: 'Develop accessible web pages',
    responsibilities: 'Work on team projects',
    qualifications: 'Enrolled student',
    location: 'Bangkok',
    work_mode: 'HYBRID',
    hours_per_week: 40,
    allowance: { type: 'NONE' },
    period: { start: '2099-01-01', end: '2099-04-01' },
    target_majors: ['Computer Science'],
    quota: 2,
    application_deadline: '2098-12-26',
    tag_ids: [tagId],
  });

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    for (const id of [companyId, otherCompanyId]) {
      await db.prisma.companySnapshot.create({
        data: {
          companyId: id,
          name: 'Test Company',
          status: 'VERIFIED',
          entityVersion: 1,
          universityPartner: false,
          verifiedBadge: true,
        },
      });
    }
    tagId = (await db.prisma.tag.findUniqueOrThrow({ where: { slug: 'nextjs' } })).id;
    replacementTagId = (await db.prisma.tag.findUniqueOrThrow({ where: { slug: 'nestjs' } })).id;
    inactiveTagId = (
      await db.prisma.tag.update({ where: { slug: 'rust' }, data: { active: false } })
    ).id;
    const config = new ConfigService({
      JOB_DATABASE_URL: db.url,
      JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
    });
    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        TestOutboxModule,
        HrJobsModule,
      ],
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

  it('returns §5.4 tag issues and leaves existing tags unchanged after a failed patch', async () => {
    const job = await http().post(base).set(owner).send(document()).expect(201);
    const cases = [
      { ids: [], issue: 'TAGS_COUNT' },
      { ids: [tagId, tagId.toUpperCase()], issue: 'TAGS_COUNT' },
      { ids: Array.from({ length: 11 }, () => randomUUID()), issue: 'TAGS_COUNT' },
      { ids: [randomUUID()], issue: 'TAG_UNKNOWN' },
      { ids: ['bad-id'], issue: 'TAG_UNKNOWN' },
      { ids: [inactiveTagId], issue: 'TAG_INACTIVE' },
    ];
    for (const { ids, issue } of cases) {
      const create = await http().post(base).set(owner).send({ tag_ids: ids }).expect(400);
      const patch = await http()
        .patch(`${base}/${job.body.id}`)
        .set(owner)
        .send({ tag_ids: ids })
        .expect(400);
      for (const res of [create, patch]) {
        expect(res.body.error.code).to.equal('VALIDATION_FAILED');
        expect(res.body.error.details).to.deep.equal([{ field: 'tag_ids', issue }]);
      }
    }
    await http()
      .patch(`${base}/${job.body.id}`)
      .set(owner)
      .send({ tag_ids: [replacementTagId] })
      .expect(200);
    const read = await http().get(`${base}/${job.body.id}`).set(owner).expect(200);
    expect(read.body.tags).to.deep.equal([
      { id: replacementTagId, name: 'NestJs', slug: 'nestjs' },
    ]);
  });

  it('checks company ownership, HR Member scope, and missing fields on draft submit', async () => {
    const draft = await http().post(base).set(owner).send({ job_title: 'Incomplete' }).expect(201);
    expect(draft.body.tags).to.deep.equal([]);
    const id = draft.body.id as string;
    const missing = await http().post(`${base}/${id}/actions/submit`).set(owner).expect(400);
    expect(missing.body.error.code).to.equal('MISSING_REQUIRED_JOB_FIELDS');
    expect(missing.body.error.details).to.deep.include({ field: 'tag_ids', issue: 'REQUIRED' });
    await http().get(base).expect(401);
    await http()
      .get(base)
      .set(auth(companyId, { role: 'STUDENT' }))
      .expect(403);
    await http().get(`${base}/${id}`).set(auth(otherCompanyId)).expect(404);
    await http()
      .patch(`${base}/${id}`)
      .set(auth(otherCompanyId))
      .send({ job_title: 'Foreign' })
      .expect(404);
    await http().post(base).set(auth(randomUUID())).send(document()).expect(403);

    const techMember = auth(companyId, { company_role: 'MEMBER', company_categories: ['TECH_IT'] });
    const denied = await http()
      .post(base)
      .set(techMember)
      .send({ ...document(), category: 'BUSINESS_MARKETING' })
      .expect(403);
    expect(denied.body.error.details).to.deep.equal([
      { field: 'category', issue: 'FORBIDDEN_CATEGORY' },
    ]);
    const job = await http().post(base).set(techMember).send(document()).expect(201);
    await http()
      .get(`${base}/${job.body.id}`)
      .set(auth(companyId, { company_role: 'MEMBER', company_categories: [] }))
      .expect(403);
    const filtered = await http()
      .get(`${base}?category=BUSINESS_MARKETING`)
      .set(techMember)
      .expect(200);
    expect(filtered.body.data).to.deep.equal([]);
  });

  it('publishes six jobs immediately, commits one event per transition, and leaves ordinary edits published', async () => {
    for (let n = 0; n < 6; n += 1) {
      const created = await http().post(base).set(owner).send(document()).expect(201);
      const id = created.body.id as string;
      const url = `${base}/${id}`;
      const attempts = await Promise.all([
        http().post(`${url}/actions/submit`).set(owner),
        http().post(`${url}/actions/submit`).set(owner),
      ]);
      expect(attempts.map((item) => item.status).sort()).to.deep.equal([200, 409]);
      expect(attempts.find((item) => item.status === 200)!.body.status).to.equal('PUBLISHED');
      const edit = await http()
        .patch(url)
        .set(owner)
        .send({ description: 'Updated description' })
        .expect(200);
      expect(edit.body).to.include({ status: 'PUBLISHED', requires_reverification: false });
      const events = await db.prisma.outboxEvent.findMany({ where: { aggregateId: id } });
      expect(events.map((event) => event.type)).to.deep.equal(['JobStatusChanged']);
      expect(events[0].payload).to.include({
        from_status: 'DRAFT',
        to_status: 'PUBLISHED',
        application_effect: 'NONE',
      });
      const history = await db.prisma.statusHistory.findMany({ where: { entityId: id } });
      expect(history).to.have.length(1);
      expect(history[0]).to.include({ toStatus: 'PUBLISHED', actorRole: 'COMPANY_HR' });
      expect(await db.prisma.jobSubmission.count({ where: { jobId: id } })).to.equal(0);
    }
  });

  it('locks category after DRAFT, permits the same value, and rejects edits and submit in a legacy status', async () => {
    const created = await http().post(base).set(owner).send(document()).expect(201);
    const url = `${base}/${created.body.id}`;
    await http().patch(url).set(owner).send({ category: 'BUSINESS_MARKETING' }).expect(200);
    await http().post(`${url}/actions/submit`).set(owner).expect(200);
    const badCategory = async (path: string) => {
      const res = await http()
        .patch(path)
        .set(owner)
        .send({ category: 'TECH_IT', quota: 5 })
        .expect(400);
      expect(res.body.error.code).to.equal('VALIDATION_FAILED');
      expect(res.body.error.details).to.deep.equal([
        { field: 'category', issue: 'CATEGORY_LOCKED' },
      ]);
    };
    await badCategory(url);
    await http()
      .patch(url)
      .set(owner)
      .send({ category: 'BUSINESS_MARKETING', quota: 3 })
      .expect(200);
    await http().post(`${url}/actions/close`).set(owner).expect(200);
    await badCategory(url);
    await http()
      .patch(url)
      .set(owner)
      .send({ category: 'BUSINESS_MARKETING', quota: 4 })
      .expect(200);
    await http().post(`${url}/actions/reopen`).set(owner).expect(200);
    const legacy = await seedJob(db.prisma, 'AUTO_REJECTED', {
      companyId,
      category: 'BUSINESS_MARKETING',
    });
    for (const category of ['BUSINESS_MARKETING', 'TECH_IT']) {
      const res = await http().patch(`${base}/${legacy.id}`).set(owner).send({ category }).expect(409);
      expect(res.body.error.code).to.equal('STATE_CONFLICT');
    }
    await http().post(`${base}/${legacy.id}/actions/submit`).set(owner).expect(409);
  });

  it('allows reopen through the Bangkok deadline date and rejects it at the next midnight', async () => {
    const deadline = new Date('2098-11-16');
    const lastDay = await seedJob(db.prisma, 'CLOSED', { companyId, applicationDeadline: deadline });
    const expired = await seedJob(db.prisma, 'CLOSED', { companyId, applicationDeadline: deadline });
    const clock = sinon.useFakeTimers({ now: new Date('2098-11-16T16:59:59.999Z'), toFake: ['Date'] });
    try {
      const deadlineOwner = auth(companyId);
      const reopened = await http().post(`${base}/${lastDay.id}/actions/reopen`).set(deadlineOwner).expect(200);
      expect(reopened.body.status).to.equal('PUBLISHED');

      clock.setSystemTime(new Date('2098-11-16T17:00:00.000Z'));
      const rejected = await http().post(`${base}/${expired.id}/actions/reopen`).set(deadlineOwner).expect(409);
      expect(rejected.body.error.code).to.equal('STATE_CONFLICT');
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: expired.id } })).to.deep.equal(expired);
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: expired.id } })).to.equal(0);
    } finally {
      clock.restore();
    }
  });

  for (const status of ['VERIFYING', 'PENDING_REVIEW', 'SUSPENDED', 'REMOVED'] as const) {
    it(`rejects PATCH in ${status} before checking same or changed category`, async () => {
      const job = await seedJob(db.prisma, status, { companyId });
      for (const category of ['TECH_IT', 'BUSINESS_MARKETING']) {
        const res = await http().patch(`${base}/${job.id}`).set(owner).send({ category }).expect(409);
        expect(res.body.error.code).to.equal('STATE_CONFLICT');
      }
      expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.include({
        status, category: 'TECH_IT', entityVersion: job.entityVersion,
      });
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
    });
  }

  for (const status of ['PUBLISHED', 'ADMIN_REJECTED', 'CLOSED'] as const) {
    it(`locks category in editable ${status} and accepts the existing value without emitting an event`, async () => {
      const job = await seedJob(db.prisma, status, { companyId });
      const url = `${base}/${job.id}`;
      const error = await http().patch(url).set(owner).send({ category: 'BUSINESS_MARKETING' }).expect(400);
      expect(error.body.error.code).to.equal('VALIDATION_FAILED');
      expect(error.body.error.details).to.deep.equal([{ field: 'category', issue: 'CATEGORY_LOCKED' }]);
      const unchanged = await http().patch(url).set(owner).send({ category: 'TECH_IT' }).expect(200);
      expect(unchanged.body).to.include({ status, category: 'TECH_IT', requires_reverification: false });
      expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
    });
  }

  it('atomically queues a flagged submission, stores the admin reason, and queues only actual content edits', async () => {
    const alsoOwner = auth(otherCompanyId);
    await db.prisma.companyFlag.create({
      data: { companyId: otherCompanyId, underReview: true, entityVersion: 1 },
    });
    const created = await http().post(base).set(alsoOwner).send(document()).expect(201);
    const id = created.body.id as string;
    const url = `${base}/${id}`;
    const response = await http().post(`${url}/actions/submit`).set(alsoOwner).expect(200);
    expect(response.body.status).to.equal('VERIFYING');
    const submission = await db.prisma.jobSubmission.findFirstOrThrow({ where: { jobId: id } });
    const events = await db.prisma.outboxEvent.findMany({
      where: { aggregateId: id },
      orderBy: { createdAt: 'asc' },
    });
    expect(events.map((event) => event.type)).to.deep.equal(['JobStatusChanged', 'JobSubmitted']);
    expect(events[0].correlationId).to.equal(events[1].correlationId);
    expect(events[1].payload).to.include({
      submission_id: submission.id,
      submission_kind: 'NEW',
      company_flag_under_review: true,
    });
    const verify = app.get(JobVerificationService);
    await db.prisma.$transaction((tx) =>
      verify.handleJobVerified(jobVerified(id, submission.id, 'PENDING_REVIEW'), tx),
    );
    const rejection = jobVerified(id, submission.id, 'ADMIN_REJECT');
    rejection.payload.decided_by = 'ADMIN';
    rejection.payload.reasons = [{ code: 'ADMIN_REASON', detail: 'กรุณาแก้รายละเอียดประกาศ' }];
    await db.prisma.$transaction((tx) => verify.handleJobVerified(rejection, tx));
    const detail = await http().get(url).set(alsoOwner).expect(200);
    expect(detail.body).to.include({
      status: 'ADMIN_REJECTED',
      admin_reason: 'กรุณาแก้รายละเอียดประกาศ',
    });
    expect(detail.body.tags).to.have.length(1);

    await db.prisma.companyFlag.update({
      where: { companyId: otherCompanyId },
      data: { underReview: false },
    });
    const resubmitted = await http().post(`${url}/actions/submit`).set(alsoOwner).expect(200);
    expect(resubmitted.body.status).to.equal('PUBLISHED');
    expect(resubmitted.body).not.to.have.property('admin_reason');
    await db.prisma.companyFlag.update({
      where: { companyId: otherCompanyId },
      data: { underReview: true },
    });

    const structural = await http()
      .patch(url)
      .set(alsoOwner)
      .send({ tag_ids: [replacementTagId], description: document().description })
      .expect(200);
    expect(structural.body).to.include({ status: 'PUBLISHED', requires_reverification: false });
    const edit = await http()
      .patch(url)
      .set(alsoOwner)
      .send({ description: 'Changed content' })
      .expect(200);
    expect(edit.body).to.include({ status: 'VERIFYING', requires_reverification: true });
    const submissions = await db.prisma.jobSubmission.findMany({
      where: { jobId: id },
      orderBy: { submittedAt: 'asc' },
    });
    expect(submissions.map((item) => item.kind)).to.deep.equal(['NEW', 'EDIT']);
    expect(submissions[1].changedFields).to.deep.equal(['description']);
    const timeout = app.get(JobVerificationTimeoutService);
    await timeout.advanceTimedOutJobs(new Date(submissions[1].submittedAt.getTime() + 299_999));
    expect((await db.prisma.job.findUniqueOrThrow({ where: { id } })).status).to.equal('VERIFYING');
    await timeout.advanceTimedOutJobs(new Date(submissions[1].submittedAt.getTime() + 300_000));
    expect((await db.prisma.job.findUniqueOrThrow({ where: { id } })).status).to.equal(
      'PENDING_REVIEW',
    );
    const last = await db.prisma.outboxEvent.findFirstOrThrow({
      where: { aggregateId: id },
      orderBy: { createdAt: 'desc' },
    });
    expect(last.payload).to.include({
      to_status: 'PENDING_REVIEW',
      reason_code: 'VERIFY_TIMEOUT',
      submission_id: submissions[1].id,
    });
  });
});
