import { execFileSync } from 'node:child_process';
import { createSign, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
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

describe('Identity company directory (Postgres จริง)', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let app: INestApplication;
  let db: PrismaService;
  let ratings: DirectoryRatingService;
  let privateKey: string;
  let viewerId: string;
  let alphaId: string;
  let betaId: string;
  let pendingId: string;
  const jwt = (id: string) => {
    const now = Math.floor(Date.now() / 1000);
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    const input = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ sub: id, role: 'STUDENT',
      jti: randomUUID(), iat: now, exp: now + 900 })}`;
    return `Bearer ${input}.${createSign('RSA-SHA256').update(input).sign(privateKey).toString('base64url')}`;
  };

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
    const pair = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' } });
    privateKey = pair.privateKey;
    process.env.JWT_PUBLIC_KEY = pair.publicKey;
    const moduleRef = await Test.createTestingModule({ imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      PrismaModule, DirectoryModule] }).compile();
    app = moduleRef.createNestApplication(); configureApp(app); await app.init();
    db = app.get(PrismaService); ratings = app.get(DirectoryRatingService);
    const universityId = (await db.university.create({ data: { name: 'Test U', emailDomain: 'test.ac.th' } })).id;
    viewerId = (await db.user.create({ data: { email: 'directory@test.ac.th', passwordHash: 'secret', fullName: 'Viewer',
      role: 'STUDENT', status: 'ACTIVE', emailVerifiedAt: new Date(), universityId } })).id;
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
    for (const name of ['IDENTITY_DATABASE_URL', 'IDENTITY_DIRECT_URL', 'S3_PUBLIC_BASE_URL', 'JWT_PUBLIC_KEY']) {
      delete process.env[name];
    }
  });

  it('shows only verified companies and supports name/partner filters', async () => {
    const all = await request(app.getHttpServer()).get('/v1/directory/companies')
      .set('Authorization', jwt(viewerId)).expect(200);
    expect(all.body.map((company: { id: string }) => company.id)).to.deep.equal([alphaId, betaId]);
    expect(all.body[0]).to.include({ name: 'Alpha Studio', university_partner: true, rating_avg: 0, review_count: 0 });
    expect(all.body[0].logo_url).to.equal('https://assets.example.test/companies/a/logo%20image.png');
    expect(all.body[0]).not.to.have.property('registration_no');
    const search = await request(app.getHttpServer()).get('/v1/directory/companies?q=ALPHA&partner=true')
      .set('Authorization', jwt(viewerId)).expect(200);
    expect(search.body.map((company: { id: string }) => company.id)).to.deep.equal([alphaId]);
    const nonPartner = await request(app.getHttpServer()).get('/v1/directory/companies?partner=false')
      .set('Authorization', jwt(viewerId)).expect(200);
    expect(nonPartner.body.map((company: { id: string }) => company.id)).to.deep.equal([betaId]);
    await request(app.getHttpServer()).get('/v1/directory/companies?partner=maybe')
      .set('Authorization', jwt(viewerId)).expect(400);
    await request(app.getHttpServer()).get('/v1/directory/companies?category=TECH')
      .set('Authorization', jwt(viewerId)).expect(400);
  });

  it('hides unverified details and requires a live authenticated user', async () => {
    const detail = await request(app.getHttpServer()).get(`/v1/directory/companies/${alphaId}`)
      .set('Authorization', jwt(viewerId)).expect(200);
    expect(detail.body).to.include({ id: alphaId, website: 'https://alpha.test' });
    await request(app.getHttpServer()).get(`/v1/directory/companies/${pendingId}`)
      .set('Authorization', jwt(viewerId)).expect(404);
    await request(app.getHttpServer()).get('/v1/directory/companies/not-a-uuid')
      .set('Authorization', jwt(viewerId)).expect(400);
    await request(app.getHttpServer()).get('/v1/directory/companies').expect(401);
    await db.user.update({ where: { id: viewerId }, data: { status: 'SUSPENDED' } });
    await request(app.getHttpServer()).get('/v1/directory/companies')
      .set('Authorization', jwt(viewerId)).expect(401);
    await db.user.update({ where: { id: viewerId }, data: { status: 'ACTIVE' } });
  });

  it('applies absolute review statistics only when entity_version increases', async () => {
    const base: ReviewPublishedPayload = { review_id: randomUUID(), company_id: alphaId, rating: 5,
      company_review_count: 2, company_rating_sum: 9, entity_version: 2, published_at: new Date().toISOString() };
    await db.$transaction((tx) => ratings.apply(base, tx));
    await db.$transaction((tx) => ratings.apply({ ...base, company_review_count: 1, company_rating_sum: 1,
      entity_version: 1 }, tx));
    await db.$transaction((tx) => ratings.apply({ ...base, company_review_count: 2, company_rating_sum: 2 }, tx));
    let detail = await request(app.getHttpServer()).get(`/v1/directory/companies/${alphaId}`)
      .set('Authorization', jwt(viewerId)).expect(200);
    expect(detail.body).to.include({ rating_avg: 4.5, review_count: 2 });
    await db.$transaction((tx) => ratings.apply({ ...base, company_review_count: 3,
      company_rating_sum: 13, entity_version: 3 }, tx));
    detail = await request(app.getHttpServer()).get(`/v1/directory/companies/${alphaId}`)
      .set('Authorization', jwt(viewerId)).expect(200);
    expect(detail.body.rating_avg).to.equal(13 / 3);
    expect(detail.body.review_count).to.equal(3);
    expect((await db.companyRatingStats.findUniqueOrThrow({ where: { companyId: alphaId } })).entityVersion).to.equal(3);
  });
});
