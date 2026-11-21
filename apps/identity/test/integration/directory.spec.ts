import { rejects } from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { configureApp } from '@internpath/common';
import type { ReviewPublishedPayload } from '@internpath/contracts';
import { expect } from 'chai';
import { Client } from 'pg';
import request from 'supertest';
import { DirectoryModule } from '../../src/modules/directory/directory.module';
import { DirectoryRatingService } from '../../src/modules/directory/directory-rating.service';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';

const APP_ROOT = path.resolve(__dirname, '../..');
const ROOT_ENV = path.resolve(APP_ROOT, '../../.env');
function adminUrl(): string | undefined {
  if (process.env.IDENTITY_IT_ADMIN_URL) return process.env.IDENTITY_IT_ADMIN_URL;
  if (!existsSync(ROOT_ENV)) return undefined;
  const line = readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/).find((value) => value.startsWith('IDENTITY_DIRECT_URL='));
  if (!line) return undefined;
  const url = new URL(line.slice('IDENTITY_DIRECT_URL='.length).replace(/^"|"$/g, ''));
  url.pathname = '/postgres';
  return url.toString();
}

const ids = (body: { data: { id: string }[] }) => body.data.map((company) => company.id);

describe('Identity company directory (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let ratings: DirectoryRatingService;
  let alphaId: string;
  let betaId: string;
  let pendingId: string;
  const get = (url: string) => request(app.getHttpServer()).get(url);

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try { await admin.connect(); await admin.query('SELECT 1'); }
    catch { await admin.end().catch(() => undefined); this.skip(); }
    dbName = `id_dir_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const url = new URL(base); url.pathname = `/${dbName}`;
    const testUrl = url.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT, env: { ...process.env, IDENTITY_DATABASE_URL: testUrl, IDENTITY_DIRECT_URL: testUrl }, stdio: 'pipe',
    });
    process.env.IDENTITY_DATABASE_URL = testUrl;
    process.env.IDENTITY_DIRECT_URL = testUrl;
    process.env.S3_PUBLIC_BASE_URL = 'https://assets.example.test';
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule, DirectoryModule] }).compile();
    app = moduleRef.createNestApplication(); configureApp(app); await app.init();
    db = app.get(PrismaService); ratings = app.get(DirectoryRatingService);
    alphaId = (await db.company.create({ data: { name: 'Alpha Studio', registrationNo: 'DIR-001',
      emailDomain: 'alpha.test', status: 'VERIFIED', universityPartner: true,
      website: 'https://alpha.test', logoKey: 'companies/a/logo image.png' } })).id;
    betaId = (await db.company.create({ data: { name: 'Beta Labs', registrationNo: 'DIR-002',
      emailDomain: 'beta.test', status: 'VERIFIED' } })).id;
    pendingId = (await db.company.create({ data: { name: 'Pending Co', registrationNo: 'DIR-003',
      emailDomain: 'pending.test', status: 'PENDING' } })).id;
  });

  after(async () => {
    await app?.close();
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
    for (const name of ['IDENTITY_DATABASE_URL', 'IDENTITY_DIRECT_URL', 'S3_PUBLIC_BASE_URL']) delete process.env[name];
  });

  it('is public: no token needed, and only verified companies are listed', async () => {
    const all = await get('/v1/directory/companies').expect(200);
    expect(ids(all.body)).to.deep.equal([alphaId, betaId]);
    expect(all.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 2 });
    expect(all.body.data[0]).to.include({ name: 'Alpha Studio', university_partner: true, rating_avg: 0, review_count: 0 });
    expect(all.body.data[0].logo_url).to.equal('https://assets.example.test/companies/a/logo%20image.png');
    expect(all.body.data[0]).not.to.have.property('registration_no');
  });

  it('supports name/partner filters', async () => {
    expect(ids((await get('/v1/directory/companies?q=ALPHA&partner=true').expect(200)).body)).to.deep.equal([alphaId]);
    expect(ids((await get('/v1/directory/companies?partner=false').expect(200)).body)).to.deep.equal([betaId]);
    await get('/v1/directory/companies?partner=maybe').expect(400);
    await get('/v1/directory/companies?category=TECH').expect(400);
  });

  it('paginates with page/page_size (max 100)', async () => {
    const second = await get('/v1/directory/companies?page=2&page_size=1').expect(200);
    expect(ids(second.body)).to.deep.equal([betaId]);
    expect(second.body.meta).to.deep.equal({ page: 2, page_size: 1, total: 2 });
    expect(ids((await get('/v1/directory/companies?page=3&page_size=1').expect(200)).body)).to.deep.equal([]);
    await get('/v1/directory/companies?page_size=101').expect(400);
    await get('/v1/directory/companies?page=0').expect(400);
    await get('/v1/directory/companies?sort=name').expect(400);
  });

  it('fetches many by ids, silently dropping unknown and unverified ones', async () => {
    const res = await get(`/v1/directory/companies?ids=${betaId},${pendingId},${randomUUID()},${alphaId.toUpperCase()}`)
      .expect(200);
    expect(ids(res.body)).to.deep.equal([alphaId, betaId]);
    expect(res.body.meta.total).to.equal(2);
    const fifty = Array.from({ length: 50 }, () => randomUUID());
    await get(`/v1/directory/companies?ids=${fifty.join(',')}`).expect(200);
    for (const bad of [[...fifty, randomUUID()].join(','), 'not-a-uuid', `${alphaId},`, '']) {
      const err = await get(`/v1/directory/companies?ids=${bad}`).expect(400);
      expect(err.body.error.code).to.equal('VALIDATION_FAILED');
    }
  });

  it('shows details publicly and hides unverified companies', async () => {
    const detail = await get(`/v1/directory/companies/${alphaId}`).expect(200);
    expect(detail.body).to.include({ id: alphaId, website: 'https://alpha.test' });
    await get(`/v1/directory/companies/${pendingId}`).expect(404);
    await get('/v1/directory/companies/not-a-uuid').expect(400);
  });

  it('applies absolute review statistics only when entity_version increases', async () => {
    const base: ReviewPublishedPayload = { review_id: randomUUID(), company_id: alphaId, rating: 5,
      company_review_count: 2, company_rating_sum: 9, entity_version: 2, published_at: new Date().toISOString() };
    await db.$transaction((tx) => ratings.apply(base, tx));
    await db.$transaction((tx) => ratings.apply({ ...base, company_review_count: 1, company_rating_sum: 1,
      entity_version: 1 }, tx));
    await db.$transaction((tx) => ratings.apply({ ...base, company_review_count: 2, company_rating_sum: 2 }, tx));
    let detail = await get(`/v1/directory/companies/${alphaId}`).expect(200);
    expect(detail.body).to.include({ rating_avg: 4.5, review_count: 2 });
    await db.$transaction((tx) => ratings.apply({ ...base, company_review_count: 3,
      company_rating_sum: 13, entity_version: 3 }, tx));
    detail = await get(`/v1/directory/companies/${alphaId}`).expect(200);
    expect(detail.body.rating_avg).to.equal(13 / 3);
    expect(detail.body.review_count).to.equal(3);
    expect((await db.companyRatingStats.findUniqueOrThrow({ where: { companyId: alphaId } })).entityVersion).to.equal(3);
  });

  it('clears Directory statistics when the last review is removed and ignores stale totals', async () => {
    const published: ReviewPublishedPayload = {
      review_id: randomUUID(), company_id: betaId, rating: 4, company_review_count: 1,
      company_rating_sum: 4, entity_version: 1, published_at: new Date().toISOString(),
    };
    await db.$transaction((tx) => ratings.apply(published, tx));
    expect((await get(`/v1/directory/companies/${betaId}`).expect(200)).body)
      .to.include({ rating_avg: 4, review_count: 1 });

    const removed = {
      ...published, change: 'REMOVED', company_review_count: 0,
      company_rating_sum: 0, entity_version: 2,
    };
    await db.$transaction((tx) => ratings.apply(removed, tx));
    await db.$transaction((tx) => ratings.apply(published, tx));
    expect((await get(`/v1/directory/companies/${betaId}`).expect(200)).body)
      .to.include({ rating_avg: 0, review_count: 0 });
    expect(await db.companyRatingStats.findUniqueOrThrow({ where: { companyId: betaId } }))
      .to.include({ entityVersion: 2, ratingSum: 0, reviewCount: 0 });

    const legacy = { ...published, company_review_count: 0, company_rating_sum: 0, entity_version: 3 };
    await db.$transaction((tx) => ratings.apply(legacy, tx));
    expect((await db.companyRatingStats.findUniqueOrThrow({ where: { companyId: betaId } })).entityVersion)
      .to.equal(3);
  });

  it('rejects impossible absolute totals without changing the Directory snapshot', async () => {
    const original: ReviewPublishedPayload = {
      review_id: randomUUID(), company_id: pendingId, rating: 4, company_review_count: 1,
      company_rating_sum: 4, entity_version: 1, published_at: new Date().toISOString(),
    };
    await db.$transaction((tx) => ratings.apply(original, tx));
    const before = await db.companyRatingStats.findUniqueOrThrow({ where: { companyId: pendingId } });
    for (const [count, sum] of [[-1, 0], [0, 1], [1, 0], [1, 6], [1, 1.5]]) {
      const payload: ReviewPublishedPayload = {
        ...original, company_review_count: count, company_rating_sum: sum, entity_version: 2,
      };
      await rejects(db.$transaction((tx) => ratings.apply(payload, tx)), /Invalid ReviewPublished rating statistics/);
    }
    const after = await db.companyRatingStats.findUniqueOrThrow({ where: { companyId: pendingId } });
    expect(after).to.deep.equal(before);
  });
});
