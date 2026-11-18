import { randomUUID } from 'node:crypto';
import { BrokerConnection, configureApp } from '@internpath/common';
import {
  EVENTS_EXCHANGE,
  routingKey,
  type CompanyStatus,
  type EventEnvelope,
  type JobObject,
  type Paginated,
  type SearchJobItem,
} from '@internpath/contracts';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import sinon from 'sinon';
import request from 'supertest';
import { Prisma } from '../../generated/client';
import { JobModule } from '../../src/job.module';
import { createBrokerSandboxOrSkip, type BrokerSandbox } from '../support/broker';
import { companyStatusEvent } from '../support/company-events';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { NOW, jobVerified, reportThreshold, seedJob } from '../support/job-events';
import { deletionMarker, deletionRequested } from '../support/user-deletion';
import { eventually } from '../support/wait';

const hiddenStatuses = [
  'DRAFT',
  'VERIFYING',
  'PENDING_REVIEW',
  'AUTO_REJECTED',
  'ADMIN_REJECTED',
  'SUSPENDED',
  'REMOVED',
] as const;
const id = (n: number) => `00000000-1000-4000-8000-${String(n).padStart(12, '0')}`;
const day = (n: number) => new Date(`2099-12-${n}T00:00:00.000Z`);
const designMajors = ['Mathematics', 'Computer   Science', 'วิทยาการ คอมพิวเตอร์'];

describe('Public Job Search and Detail (real PostgreSQL)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let broker: BrokerSandbox;
  let app: INestApplication;
  let publisher: BrokerConnection;
  let config: ConfigService;
  const featuredCompany = randomUUID();
  const regularCompany = randomUUID();
  const companyWithoutEntitlement = randomUUID();

  before(async function () {
    await dbReachableOrSkip(this);
    broker = await createBrokerSandboxOrSkip(this);
    db = await createTestDatabase();
    config = new ConfigService({
      JOB_DATABASE_URL: db.url,
      JOB_DIRECT_URL: db.url,
      RABBITMQ_URL: broker.url,
      S3_PUBLIC_BASE_URL: 'https://assets.example.test/',
      S3_ENDPOINT: 'https://storage.example.test/',
      S3_BUCKET_PUBLIC: 'public-bucket',
    });
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), JobModule],
    })
      .overrideProvider(ConfigService)
      .useValue(config)
      .compile();
    app = module.createNestApplication();
    configureApp(app);
    await app.init();
    publisher = new BrokerConnection({ url: broker.url });
    await publisher.connect();

    await db.prisma.companySnapshot.createMany({
      data: [
        {
          companyId: featuredCompany,
          name: 'Data Studio',
          logoKey: 'companies/logo white.webp',
          universityPartner: true,
        },
        { companyId: regularCompany, name: 'Plain Company', universityPartner: false },
        { companyId: companyWithoutEntitlement, name: 'Small Company', universityPartner: false },
      ].map((company) => ({
        ...company,
        status: 'VERIFIED',
        verifiedBadge: true,
        entityVersion: 4,
      })),
    });
    await db.prisma.companyEntitlement.createMany({
      data: [
        {
          companyId: featuredCompany,
          featuredEnabled: true,
          fastTrackEnabled: false,
          entityVersion: 2,
        },
        {
          companyId: regularCompany,
          featuredEnabled: false,
          fastTrackEnabled: true,
          entityVersion: 3,
        },
      ],
    });
    await seedJob(db.prisma, 'PUBLISHED', {
      id: id(1),
      companyId: featuredCompany,
      featured: true,
      publishedAt: day(14),
      applicationDeadline: day(26),
      jobTitle: 'Data Design Intern',
      workMode: 'REMOTE',
      category: 'BUSINESS_MARKETING',
      allowanceType: 'AMOUNT',
      allowanceAmountThb: 350,
      allowanceText: 'Daily',
      targetMajors: designMajors,
      quotaReserved: 1,
      quotaConfirmed: 2,
      contactNotes: 'private fixture',
    });
    await seedJob(db.prisma, 'PUBLISHED', {
      id: id(2),
      companyId: featuredCompany,
      featured: true,
      publishedAt: day(16),
      applicationDeadline: day(28),
    });
    await seedJob(db.prisma, 'PUBLISHED', {
      id: id(3),
      companyId: featuredCompany,
      featured: false,
      publishedAt: day(17),
      applicationDeadline: day(24),
      jobTitle: 'Data 50%_\\ Lab',
    });
    await seedJob(db.prisma, 'PUBLISHED', {
      id: id(4),
      companyId: regularCompany,
      featured: true,
      publishedAt: day(17),
      applicationDeadline: day(24),
    });
    await seedJob(db.prisma, 'PUBLISHED', {
      id: id(5),
      companyId: regularCompany,
      publishedAt: day(15),
      applicationDeadline: day(22),
      jobTitle: 'นักศึกษาฝึกงานวิเคราะห์ข้อมูล',
    });
    await seedJob(db.prisma, 'PUBLISHED', {
      id: id(6),
      companyId: companyWithoutEntitlement,
      featured: true,
      publishedAt: null,
      applicationDeadline: day(25),
    });
    await seedJob(db.prisma, 'CLOSED', {
      id: id(7),
      companyId: featuredCompany,
      featured: true,
      publishedAt: day(20),
    });
    await seedJob(db.prisma, 'PUBLISHED', { id: id(8) }); // No company snapshot yet.
    for (const [index, status] of hiddenStatuses.entries()) {
      if (status === 'DRAFT') {
        await db.prisma.job.create({
          data: {
            id: id(10 + index),
            companyId: featuredCompany,
            createdBy: randomUUID(),
            status,
            version: 1,
            entityVersion: 1,
          },
        });
        continue;
      }
      await seedJob(db.prisma, status, {
        id: id(10 + index),
        companyId: featuredCompany,
        featured: true,
      });
    }
  });

  after(async () => {
    try {
      await app?.close();
    } finally {
      try {
        await publisher?.close();
      } finally {
        try {
          await db?.drop();
        } finally {
          await broker?.drop();
        }
      }
    }
  });

  const search = () => request(app.getHttpServer()).get('/v1/search/jobs');
  const detail = (jobId: string) => request(app.getHttpServer()).get(`/v1/jobs/${jobId}`);
  const list = async (params: Record<string, string | number | boolean | undefined> = {}) =>
    (await search().query(params).expect(200)).body as Paginated<SearchJobItem>;
  const send = (event: EventEnvelope) =>
    publisher.publish(
      EVENTS_EXCHANGE,
      routingKey(event.producer, event.type),
      Buffer.from(JSON.stringify(event)),
      { contentType: 'application/json', deliveryMode: 2, messageId: event.event_id },
    );
  const setCompanyStatus = async (companyId: string, version: number, status: CompanyStatus) => {
    await send(companyStatusEvent(companyId, version, { status }));
    await eventually(async () => {
      const snapshot = await db.prisma.companySnapshot.findUnique({ where: { companyId } });
      return snapshot?.entityVersion === version && snapshot.status === status;
    });
  };

  it('returns PUBLISHED results featured-first and newest-first without duplicate or hidden jobs', async () => {
    const result = await list();
    expect(result.meta).to.deep.equal({ page: 1, page_size: 20, total: 6 });
    expect(result.data.map((job) => job.id)).to.deep.equal([2, 1, 3, 4, 5, 6].map(id));
    expect(result.data.map((job) => job.featured)).to.deep.equal([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
    expect(result.data.every((job) => job.status === 'PUBLISHED')).to.equal(true);
    expect(result.data[5]).not.to.have.property('published_at');
  });

  it('sorts by nearest deadline within each featured tier and breaks ties by ID', async () => {
    expect((await list({ sort: 'deadline' })).data.map((job) => job.id)).to.deep.equal(
      [1, 2, 5, 3, 4, 6].map(id),
    );
  });

  it('supports the homepage size and returns stable pages with the full filtered total', async () => {
    const first = await list({ page_size: 3 });
    expect(first.meta).to.deep.equal({ page: 1, page_size: 3, total: 6 });
    expect(first.data.map((job) => job.id)).to.deep.equal([2, 1, 3].map(id));
    const second = await list({ page: 2, page_size: 3 });
    expect(second.meta).to.deep.equal({ page: 2, page_size: 3, total: 6 });
    expect(second.data.map((job) => job.id)).to.deep.equal([4, 5, 6].map(id));
    expect(await list({ page: 3, page_size: 3 })).to.deep.equal({
      data: [],
      meta: { page: 3, page_size: 3, total: 6 },
    });
    expect((await list({ page_size: 100 })).meta.page_size).to.equal(100);
    expect(await list({ page: Number.MAX_SAFE_INTEGER, page_size: 100 })).to.deep.equal({
      data: [],
      meta: { page: Number.MAX_SAFE_INTEGER, page_size: 100, total: 6 },
    });
  });

  it('combines filters and treats q as case-insensitive literal text in title or company name', async () => {
    const q = {
      q: ' dAtA ',
      category: 'BUSINESS_MARKETING',
      work_mode: 'REMOTE',
      allowance: true,
      company_id: featuredCompany,
    };
    const result = await list(q);
    expect(result.meta.total).to.equal(1);
    expect(result.data.map((job) => job.id)).to.deep.equal([id(1)]);
    for (const filter of [
      { category: 'TECH_IT', work_mode: 'REMOTE' },
      { company_id: regularCompany, allowance: true },
      { q: "%' OR true --" },
    ]) {
      expect((await list(filter)).meta.total).to.equal(0);
    }
    expect((await list({ allowance: false })).meta.total).to.equal(6);
    expect((await list({ q: 'data studio' })).data.map((job) => job.id)).to.deep.equal(
      [2, 1, 3].map(id),
    );
    expect((await list({ q: 'Data' })).data.map((job) => job.id)).to.deep.equal([2, 1, 3].map(id));
    expect((await list({ q: 'วิเคราะห์ข้อมูล' })).data.map((job) => job.id)).to.deep.equal([id(5)]);
    expect((await list({ q: '50%_\\' })).data.map((job) => job.id)).to.deep.equal([id(3)]);
    expect((await list({ q: '_' })).data.map((job) => job.id)).to.deep.equal([id(3)]);
  });

  it('uses normalized exact major matching without changing result pages or using Authorization', async () => {
    const query = { page: 1, page_size: 2 };
    const baseline = await list(query);
    expect(baseline.meta).to.deep.equal({ page: 1, page_size: 2, total: 6 });
    expect(baseline.data.map((job) => job.id)).to.deep.equal([id(2), id(1)]);
    for (const [major, mismatch] of [
      ['cOmPuTeR ScIeNcE', false],
      ['  computer   science  ', false],
      ['วิทยาการ   คอมพิวเตอร์', false],
      ['computer sci', true],
    ] as const) {
      const expected = {
        ...baseline,
        data: baseline.data.map((job) => ({
          ...job,
          major_mismatch: job.id === id(1) ? mismatch : true,
        })),
      };
      expect(await list({ ...query, major }), major).to.deep.equal(expected);
      const authorized = await search()
        .query({ ...query, major })
        .set('Authorization', 'Bearer ignored')
        .expect(200);
      expect(authorized.body, major).to.deep.equal(expected);
    }
  });

  it('omits major_mismatch for a missing or blank major', async () => {
    const query = { page: 2, page_size: 2 };
    const omitted = await list(query);
    expect(omitted.data.every((job) => !('major_mismatch' in job))).to.equal(true);
    for (const major of ['', '   ', ' \t ']) {
      expect(await list({ ...query, major })).to.deep.equal(omitted);
    }
  });

  it('returns major_mismatch false for a published legacy row with empty target_majors', async () => {
    const title = 'Legacy empty target majors';
    const [constraint] = await db.prisma.$queryRaw<Array<{ definition: string }>>`
      SELECT pg_get_constraintdef(oid) AS definition
      FROM pg_constraint
      WHERE conrelid = 'jobs'::regclass AND conname = 'jobs_non_draft_complete_check'
        AND convalidated
    `;
    if (!constraint) throw new Error('Expected the validated Job completeness check');
    const job = await seedJob(db.prisma, 'PUBLISHED', {
      companyId: regularCompany,
      jobTitle: title,
    });
    try {
      // Model one pre-constraint row in the disposable test DB. New writes stay protected.
      await db.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`ALTER TABLE jobs DROP CONSTRAINT jobs_non_draft_complete_check`;
        await tx.job.update({ where: { id: job.id }, data: { targetMajors: [] } });
        await tx.$executeRaw`
          ALTER TABLE jobs ADD CONSTRAINT jobs_non_draft_complete_check
          ${Prisma.raw(constraint.definition)} NOT VALID
        `;
      });
      const response = await list({ q: title, major: 'Computer Science' });
      expect(response.meta.total).to.equal(1);
      expect(response.data).to.have.length(1);
      expect(response.data[0]).to.deep.include({
        id: job.id,
        target_majors: [],
        major_mismatch: false,
      });
    } finally {
      await db.prisma.$transaction([
        db.prisma.job.delete({ where: { id: job.id } }),
        db.prisma.$executeRaw`ALTER TABLE jobs VALIDATE CONSTRAINT jobs_non_draft_complete_check`,
      ]);
    }
  });

  it('rejects invalid, unsupported, and repeated query parameters using the standard error format', async () => {
    for (const query of [
      'sort=popular',
      'category=bogus',
      'work_mode=bogus',
      'allowance=1',
      'company_id=bad',
      'page=0',
      'page=1.2',
      'page=1e2',
      'page=9007199254740992',
      'page_size=101',
      'page_size=0',
      'page=1&page=2',
      'q=a&q=b',
      'q=%00',
      'major=%00',
      'major=a&major=b',
      'ids=' + featuredCompany,
    ]) {
      const response = await search().query(query).expect(400);
      expect(response.body.error.code, query).to.equal('VALIDATION_FAILED');
      expect(response.body.error).to.have.property('correlation_id');
    }
  });

  it('returns the exact public DTO, cache header, and identical responses with or without Authorization', async () => {
    const expected: JobObject = {
      id: id(1),
      company: {
        id: featuredCompany,
        name: 'Data Studio',
        badges: ['Verified by Platform', 'University Partner'],
        logo_url: 'https://assets.example.test/companies/logo%20white.webp',
      },
      category: 'BUSINESS_MARKETING',
      job_title: 'Data Design Intern',
      description: 'Description',
      responsibilities: 'Build software',
      qualifications: 'Student',
      allowance: { type: 'AMOUNT', amount_thb: 350, text: 'Daily' },
      location: 'Bangkok',
      work_mode: 'REMOTE',
      hours_per_week: 40,
      period: { start: '2027-01-01', end: '2027-04-01' },
      target_majors: designMajors,
      quota: 5,
      quota_available: 2,
      application_deadline: '2099-12-26',
      status: 'PUBLISHED',
      featured: true,
      published_at: day(14).toISOString(),
    };
    const publicDetail = await detail(id(1))
      .expect(200)
      .expect('Cache-Control', 'public, max-age=60');
    expect(publicDetail.headers).not.to.have.property('x-robots-tag');
    expect(publicDetail.body).to.deep.equal(expected);
    expect(
      (await detail(id(1)).set('Authorization', 'Bearer ignored').expect(200)).body,
    ).to.deep.equal(expected);
    const publicSearch = await search()
      .query({ q: 'Design' })
      .expect(200)
      .expect('Cache-Control', 'public, max-age=60');
    expect(publicSearch.body.data).to.deep.equal([expected]);
    expect(
      (await search().query({ q: 'Design' }).set('Authorization', 'Bearer ignored').expect(200))
        .body,
    ).to.deep.equal(publicSearch.body);
    expect((await detail(id(4)).expect(200)).body).to.include({ featured: false });
    expect((await detail(id(4)).expect(200)).body.allowance).to.deep.equal({
      type: 'NONE',
      text: '',
    });
    expect((await detail(id(4)).expect(200)).body.company).not.to.have.property('logo_url');
  });

  it('serves CLOSED without indexing and uses the same 404 for hidden, unknown, invalid, or unsnapshotted jobs', async () => {
    const closed = await detail(id(7)).expect(200).expect('X-Robots-Tag', 'noindex');
    expect(closed.body).to.include({ status: 'CLOSED', featured: false });
    const correlationId = randomUUID();
    const unknown = await detail(randomUUID()).set('X-Correlation-Id', correlationId).expect(404);
    expect(unknown.body.error.code).to.equal('NOT_FOUND');
    for (const jobId of [...hiddenStatuses.map((_, index) => id(10 + index)), id(8), 'bad-id']) {
      const response = await detail(jobId).set('X-Correlation-Id', correlationId).expect(404);
      expect(response.body, jobId).to.deep.equal(unknown.body);
    }
  });

  it('falls back to the configured public bucket URL and omits a logo when no public base is configured', async () => {
    const get = sinon.stub(config, 'get').callThrough();
    get.withArgs('S3_PUBLIC_BASE_URL').returns(undefined);
    try {
      const fallback = await detail(id(1)).expect(200);
      expect(fallback.body.company.logo_url).to.equal(
        'https://storage.example.test/public-bucket/companies/logo%20white.webp',
      );
      get.withArgs('S3_BUCKET_PUBLIC').returns(undefined);
      const unmapped = await detail(id(1)).expect(200);
      expect(unmapped.body.company).not.to.have.any.keys('logo_url', 'logo_key');
    } finally {
      get.restore();
    }
  });

  it('leaves all Job business tables unchanged when serving or rejecting public reads', async () => {
    const state = () => db.prisma.$queryRaw`
      SELECT
        (SELECT jsonb_agg(j ORDER BY j.id) FROM jobs AS j) AS jobs,
        (SELECT jsonb_agg(s ORDER BY s.id) FROM job_submissions AS s) AS submissions,
        (SELECT jsonb_agg(q ORDER BY q.application_id) FROM quota_reservations AS q) AS quotas,
        (SELECT jsonb_agg(r ORDER BY r.id) FROM report_rounds AS r) AS rounds,
        (SELECT jsonb_agg(c ORDER BY c.company_id) FROM company_snapshots AS c) AS companies,
        (SELECT jsonb_agg(e ORDER BY e.company_id) FROM company_entitlements AS e) AS entitlements,
        (SELECT jsonb_agg(f ORDER BY f.company_id) FROM company_flags AS f) AS flags,
        (SELECT jsonb_agg(h ORDER BY h.id) FROM status_history AS h) AS history,
        (SELECT jsonb_agg(o ORDER BY o.id) FROM outbox_events AS o) AS outbox,
        (SELECT jsonb_agg(p ORDER BY p.event_id, p.consumer) FROM processed_events AS p) AS processed
    `;
    const before = await state();
    await search().query({ q: 'Data', major: 'CS' }).expect(200);
    await detail(id(1)).expect(200);
    await detail(id(7)).expect(200);
    await detail(id(10)).expect(404);
    await search().query({ sort: 'unsupported' }).expect(400);
    expect(await state()).to.deep.equal(before);
  });

  it('uses E05 suspension and restoration for PUBLISHED and CLOSED visibility and paginated totals', async () => {
    const companyId = randomUUID();
    const q = 'Eligibility transition intern';
    await setCompanyStatus(companyId, 1, 'VERIFIED');
    await db.prisma.companyEntitlement.create({
      data: { companyId, featuredEnabled: true, fastTrackEnabled: false, entityVersion: 1 },
    });
    const published = await seedJob(db.prisma, 'PUBLISHED', {
      companyId,
      jobTitle: q,
      featured: true,
      publishedAt: day(14),
    });
    const closed = await seedJob(db.prisma, 'CLOSED', {
      companyId,
      jobTitle: q,
      contactNotes: 'private closed fixture',
      publishedAt: day(20),
    });
    const newer = await seedJob(db.prisma, 'PUBLISHED', {
      companyId: regularCompany,
      jobTitle: q,
      publishedAt: day(18),
    });
    const older = await seedJob(db.prisma, 'PUBLISHED', {
      companyId: regularCompany,
      jobTitle: q,
      publishedAt: day(17),
    });
    const expectPage = async (page: number, total: number, expectedIds: string[]) => {
      const result = await list({ q, page, page_size: 1 });
      expect(result.meta).to.deep.equal({ page, page_size: 1, total });
      expect(result.data.map((job) => job.id)).to.deep.equal(expectedIds);
      return result.data;
    };
    const expectJobUnchanged = async () => {
      for (const job of [published, closed]) {
        expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
        expect(await db.prisma.statusHistory.count({ where: { entityId: job.id } })).to.equal(0);
        expect(await db.prisma.outboxEvent.count({ where: { aggregateId: job.id } })).to.equal(0);
      }
    };
    const expectClosedVisible = async () => {
      const response = await detail(closed.id)
        .expect(200)
        .expect('X-Robots-Tag', 'noindex')
        .expect('Cache-Control', 'public, max-age=60');
      expect(response.body).to.include({ id: closed.id, status: 'CLOSED', featured: false });
      expect(response.body).not.to.have.any.keys(
        'contact_notes',
        'created_by',
        'suspended_from_status',
        'version',
        'entity_version',
      );
    };

    const firstPage = await expectPage(1, 3, [published.id]);
    expect(firstPage[0].featured).to.equal(true);
    await expectPage(2, 3, [newer.id]);
    await expectPage(3, 3, [older.id]);
    await detail(published.id).expect(200).expect('Cache-Control', 'public, max-age=60');
    await expectClosedVisible();

    await setCompanyStatus(companyId, 2, 'SUSPENDED');
    await expectPage(1, 2, [newer.id]);
    await expectPage(2, 2, [older.id]);
    await expectPage(3, 2, []);
    expect(await list({ q, company_id: companyId, page_size: 1 })).to.deep.equal({
      data: [],
      meta: { page: 1, page_size: 1, total: 0 },
    });
    expect((await detail(published.id).expect(404)).body.error.code).to.equal('NOT_FOUND');
    expect((await detail(closed.id).expect(404)).body.error.code).to.equal('NOT_FOUND');
    await expectJobUnchanged();

    await setCompanyStatus(companyId, 3, 'VERIFIED');
    expect((await expectPage(1, 3, [published.id]))[0].featured).to.equal(true);
    await expectPage(2, 3, [newer.id]);
    await expectPage(3, 3, [older.id]);
    expect((await detail(published.id).expect(200)).body).to.include({
      id: published.id,
      status: 'PUBLISHED',
    });
    await expectClosedVisible();
    await expectJobUnchanged();
  });

  it('excludes PUBLISHED and CLOSED jobs with missing, PENDING, NEED_MORE_INFO or REJECTED company snapshots', async () => {
    const companyId = randomUUID();
    const job = await seedJob(db.prisma, 'PUBLISHED', { companyId });
    const closed = await seedJob(db.prisma, 'CLOSED', { companyId });
    const correlationId = randomUUID();
    const unknown = await detail(randomUUID()).set('X-Correlation-Id', correlationId).expect(404);
    expect(unknown.body.error.code).to.equal('NOT_FOUND');
    const expectHidden = async (state: string) => {
      expect(await list({ company_id: companyId }), state).to.deep.equal({
        data: [],
        meta: { page: 1, page_size: 20, total: 0 },
      });
      expect((await detail(job.id).expect(404)).body.error.code, state).to.equal('NOT_FOUND');
      const response = await detail(closed.id).set('X-Correlation-Id', correlationId).expect(404);
      expect(response.body, state).to.deep.equal(unknown.body);
    };
    await expectHidden('missing company snapshot');
    const statuses = ['PENDING', 'NEED_MORE_INFO', 'PENDING', 'REJECTED'] as const;
    for (const [index, status] of statuses.entries()) {
      await setCompanyStatus(companyId, index + 1, status);
      await expectHidden(status);
    }
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).to.deep.equal(job);
    expect(await db.prisma.job.findUniqueOrThrow({ where: { id: closed.id } })).to.deep.equal(
      closed,
    );
  });

  it('reflects E02 approval, E04 suspension and restore, and E15 anonymization without exposing internal data', async () => {
    const deletion = deletionRequested();
    const job = await seedJob(db.prisma, 'VERIFYING', {
      companyId: featuredCompany,
      createdBy: deletion.payload.user_id,
      applicationDeadline: day(30),
      jobTitle: 'Workflow Intern',
      contactNotes: 'private workflow contact',
    });
    const submissionId = job.currentSubmissionId!;
    await db.prisma.jobSubmission.create({
      data: {
        id: submissionId,
        jobId: job.id,
        kind: 'NEW',
        changedFields: [],
        submittedBy: deletion.payload.user_id,
        submittedAt: NOW,
      },
    });
    const status = async () =>
      (await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status;
    await detail(job.id).expect(404);
    await send(jobVerified(job.id, submissionId));
    await eventually(async () => (await status()) === 'PUBLISHED');
    const approved = (await detail(job.id).expect(200)).body as JobObject;
    expect((await list({ q: 'Workflow Intern' })).data).to.deep.equal([approved]);

    const report = reportThreshold(job.id, job.companyId);
    await send(report);
    await eventually(async () => (await status()) === 'SUSPENDED');
    await detail(job.id).expect(404);
    expect((await list({ q: 'Workflow Intern' })).data).to.deep.equal([]);

    const restore = jobVerified(job.id, submissionId, 'RESTORE');
    restore.payload.queue_item_id = report.payload.queue_item_id;
    await send(restore);
    await eventually(async () => (await status()) === 'PUBLISHED');
    const restored = (await detail(job.id).expect(200)).body as JobObject;
    expect(restored).not.to.have.any.keys(
      'contact_notes',
      'suspended_from_status',
      'created_by',
      'version',
      'entity_version',
    );
    await send(deletion);
    await eventually(async () => (await deletionMarker(db.prisma, deletion.event_id)) === 1);
    expect((await db.prisma.job.findUniqueOrThrow({ where: { id: job.id } })).createdBy).to.equal(
      deletion.payload.anonymous_actor_id,
    );
    expect((await detail(job.id).expect(200)).body).to.deep.equal(restored);
    expect((await list({ q: 'Workflow Intern' })).data).to.deep.equal([restored]);
  });
});
