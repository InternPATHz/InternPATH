import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { configureApp } from '@internpath/common';
import type { AdminJobItem, Paginated, Role } from '@internpath/contracts';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import request from 'supertest';
import { JobStatus, type Job } from '../../generated/client';
import { AdminJobsModule } from '../../src/modules/admin/admin-jobs.module';
import { PublicJobsModule } from '../../src/modules/public-jobs/public-jobs.module';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { seedJob } from '../support/job-events';

const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
function authorization(role: Role): string {
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const data = [
    encode({ alg: 'RS256', typ: 'JWT' }),
    encode({ sub: randomUUID(), jti: randomUUID(), role, iat: now, exp: now + 3600 }),
  ].join('.');
  return (
    'Bearer ' +
    data +
    '.' +
    createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')
  );
}
const id = (n: number) => '00000000-1000-4000-8000-' + String(n).padStart(12, '0');
const createdAt = new Date('2026-11-20T00:00:00.000Z');
const deadline = new Date('2098-12-26');
const path = '/v1/admin/jobs';

describe('Admin Job API (HTTP and PostgreSQL)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let app: INestApplication;
  const statuses = Object.values(JobStatus);
  const companyId = randomUUID();
  const pendingCompanyId = randomUUID();
  const missingCompanyId = randomUUID();
  const reportQueueItemId = randomUUID();
  const jobs: Job[] = [];
  const sorted = () =>
    [...jobs].sort((a, b) => +b.createdAt - +a.createdAt || a.id.localeCompare(b.id));
  const http = () => request(app.getHttpServer());
  const adminGet = () => http().get(path).set('Authorization', authorization('PLATFORM_ADMIN'));

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    const companyDefaults = { universityPartner: false, entityVersion: 1 };
    await db.prisma.companySnapshot.createMany({
      data: [
        {
          ...companyDefaults,
          companyId,
          name: 'Verified Company',
          status: 'VERIFIED',
          verifiedBadge: true,
        },
        {
          ...companyDefaults,
          companyId: pendingCompanyId,
          name: 'Pending Company',
          status: 'PENDING',
          verifiedBadge: false,
        },
      ],
    });
    for (const [index, status] of statuses.entries()) {
      if (status === 'DRAFT') {
        jobs.push(
          await db.prisma.job.create({
            data: {
              id: id(index + 1),
              companyId: missingCompanyId,
              createdBy: randomUUID(),
              status,
              targetMajors: [],
              entityVersion: 0,
              version: 1,
              createdAt,
            },
          }),
        );
        continue;
      }
      jobs.push(
        await seedJob(db.prisma, status, {
          id: id(index + 1),
          companyId: status === 'PUBLISHED' ? companyId : pendingCompanyId,
          createdAt,
          applicationDeadline: deadline,
          contactNotes: 'Owner and Admin only',
          ...(status === 'PUBLISHED' ? { jobTitle: 'Data_Analyst', publishedAt: createdAt } : {}),
          ...(status === 'SUSPENDED' ? { suspendedFromStatus: 'PUBLISHED' } : {}),
          ...(status === 'ADMIN_REJECTED' ? { adminReason: 'Admin rejection details' } : {}),
        }),
      );
    }
    jobs.push(
      await seedJob(db.prisma, 'PUBLISHED', {
        id: id(100),
        companyId: pendingCompanyId,
        description: 'DATA Analyst position',
        publishedAt: createdAt,
        applicationDeadline: deadline,
        createdAt: new Date('2026-11-21T00:00:00.000Z'),
      }),
    );
    const suspended = jobs.find((job) => job.status === 'SUSPENDED')!;
    await db.prisma.reportRound.create({
      data: {
        jobId: suspended.id,
        queueItemId: reportQueueItemId,
        status: 'ACTIVE',
        reachedAt: createdAt,
        suspendedFromStatus: 'PUBLISHED',
      },
    });

    const module = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        AdminJobsModule,
        PublicJobsModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue(
        new ConfigService({
          JOB_DATABASE_URL: db.url,
          JWT_PUBLIC_KEY: publicKey.export({ type: 'spki', format: 'pem' }),
        }),
      )
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

  it('requires a valid JWT with the PLATFORM_ADMIN role', async () => {
    await http().get(path).expect(401);
    await http().get(path).set('Authorization', 'Bearer invalid').expect(401);
    for (const role of ['STUDENT', 'COMPANY_HR', 'ADVISOR'] as const) {
      const { body } = await http().get(path).set('Authorization', authorization(role)).expect(403);
      expect(body.error.code).to.equal('FORBIDDEN_ROLE');
    }
    await adminGet().expect('Cache-Control', 'private, no-store').expect(200);
  });

  it('includes all statuses across companies, even incomplete drafts and unverified companies', async () => {
    const { body } = await adminGet().expect(200);
    const result: Paginated<AdminJobItem> = body;
    expect(result.meta).to.deep.equal({ page: 1, page_size: 20, total: jobs.length });
    expect(new Set(result.data.map((job) => job.status))).to.deep.equal(new Set(statuses));
    const draft = result.data.find((job) => job.status === 'DRAFT')!;
    expect(draft).to.include({
      job_title: null,
      category: null,
      quota: null,
      application_deadline: null,
    });
    expect(draft.company).to.include({ id: missingCompanyId, name: '' });
    expect(result.data.find((job) => job.id === id(100))?.company).to.include({
      id: pendingCompanyId,
      name: 'Pending Company',
    });
    expect(result.data.some((job) => job.company.id === companyId)).to.equal(true);
  });

  it('filters by status, company and case-insensitive title or description, alone and together', async () => {
    const cases = [
      {
        query: { status: 'PUBLISHED' },
        ids: sorted()
          .filter((job) => job.status === 'PUBLISHED')
          .map((job) => job.id),
      },
      { query: { company_id: missingCompanyId }, ids: [id(1)] },
      { query: { q: '  dAtA  ' }, ids: [id(100), id(statuses.indexOf('PUBLISHED') + 1)] },
      { query: { q: 'dAtA aNaLySt' }, ids: [id(100)] },
      { query: { q: 'DATA_' }, ids: [id(statuses.indexOf('PUBLISHED') + 1)] },
      { query: { q: '%' }, ids: [] },
      { query: { status: 'PUBLISHED', company_id: pendingCompanyId, q: 'data' }, ids: [id(100)] },
      { query: { status: 'DRAFT', company_id: pendingCompanyId, q: 'data' }, ids: [] },
    ];
    for (const { query, ids } of cases) {
      const { body } = await adminGet().query(query).expect(200);
      const result: Paginated<AdminJobItem> = body;
      expect(result.data.map((job) => job.id)).to.deep.equal(ids);
      expect(result.meta.total).to.equal(ids.length);
    }
  });

  it('rejects unsupported or malformed filters and pagination', async () => {
    for (const query of [
      'status=DONE',
      'status=DRAFT&status=CLOSED',
      'company_id=bad',
      'q=%00',
      'q=' + 'a'.repeat(201),
      'q=one&q=two',
      'page=0',
      'page=1.5',
      'page=1e2',
      'page=9007199254740992',
      'page_size=0',
      'page_size=101',
      'other=1',
    ]) {
      const { body } = await adminGet().query(query).expect(400);
      expect(body.error.code).to.equal('VALIDATION_FAILED');
    }
  });

  it('paginates deterministically, with timestamps descending and IDs breaking ties', async () => {
    const ids = sorted().map((job) => job.id);
    for (const page of [1, 2, 3, 4, Number.MAX_SAFE_INTEGER]) {
      const { body } = await adminGet().query({ page, page_size: 3 }).expect(200);
      const result: Paginated<AdminJobItem> = body;
      expect(result.data.map((job) => job.id)).to.deep.equal(ids.slice((page - 1) * 3, page * 3));
      expect(result.meta).to.deep.equal({ page, page_size: 3, total: ids.length });
    }
  });

  it('includes Admin extras and the recorded report queue ID without exposing them publicly', async () => {
    const suspendedWithoutReport = await seedJob(db.prisma, 'SUSPENDED', {
      companyId,
      suspendedFromStatus: 'CLOSED',
    });
    const { body } = await adminGet().expect(200);
    const result: Paginated<AdminJobItem> = body;
    const suspended = result.data.find((job) => job.id === id(statuses.indexOf('SUSPENDED') + 1))!;
    expect(suspended).to.include({
      contact_notes: 'Owner and Admin only',
      suspended_from_status: 'PUBLISHED',
      report_queue_item_id: reportQueueItemId,
      created_at: createdAt.toISOString(),
    });
    expect(suspended.report_queue_item_id).not.to.equal(suspended.id);
    expect(result.data.find((job) => job.status === 'ADMIN_REJECTED')?.admin_reason).to.equal(
      'Admin rejection details',
    );
    const withoutReport = result.data.find((job) => job.id === suspendedWithoutReport.id)!;
    expect(withoutReport.suspended_from_status).to.equal('CLOSED');
    expect(withoutReport).not.to.have.property('report_queue_item_id');

    const publicJob = jobs.find(
      (job) => job.status === 'PUBLISHED' && job.companyId === companyId,
    )!;
    const detail = await http()
      .get('/v1/jobs/' + publicJob.id)
      .expect(200);
    const search = await http().get('/v1/search/jobs').expect(200);
    expect(search.body.data.map((job: { id: string }) => job.id)).to.deep.equal([publicJob.id]);
    for (const response of [detail.body, search.body.data[0]]) {
      for (const field of [
        'contact_notes',
        'admin_reason',
        'suspended_from_status',
        'report_queue_item_id',
      ]) {
        expect(response).not.to.have.property(field);
      }
    }
    await http()
      .get('/v1/jobs/' + suspended.id)
      .expect(404);
    await http()
      .get('/v1/jobs/' + jobs[0].id)
      .expect(404);
    await http()
      .get('/v1/jobs/' + id(100))
      .expect(404);
  });
});
