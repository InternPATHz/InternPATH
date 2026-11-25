import { createSign, generateKeyPairSync, randomUUID } from 'node:crypto';
import { configureApp } from '@internpath/common';
import type { AdminTag, JobTag, Paginated } from '@internpath/contracts';
import type { INestApplication } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { expect } from 'chai';
import request from 'supertest';
import { slugify } from '../../src/modules/tags/tags.service';
import { TagsModule } from '../../src/modules/tags/tags.module';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { seedJob } from '../support/job-events';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

/** JWT RS256 แบบมือ (Job ไม่มี jsonwebtoken เป็น dependency) — ตรงกับที่ JwtAuthGuard ตรวจ */
function token(role: string, sub = randomUUID()): string {
  const enc = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc({ sub, role, jti: randomUUID(), iat: now, exp: now + 3600 })}`;
  return `${body}.${createSign('RSA-SHA256').update(body).sign(privateKey).toString('base64url')}`;
}

describe('slugify', () => {
  it('ตัวพิมพ์เล็ก ตัดอักขระพิเศษ และแปลง # + .', () => {
    expect(slugify('NextJs')).to.equal('nextjs');
    expect(slugify('Node.js')).to.equal('nodejs');
    expect(slugify('C#')).to.equal('csharp');
    expect(slugify('C++')).to.equal('cplusplus');
    expect(slugify('  Machine   Learning ')).to.equal('machine-learning');
    expect(slugify('ภาษาไทย')).to.equal('');
  });
});

describe('Tags API (HTTP และ PostgreSQL จริง)', function () {
  this.timeout(60_000);
  let db: TestDatabase;
  let app: INestApplication;
  const admin = () => ({ Authorization: `Bearer ${token('PLATFORM_ADMIN')}` });
  const http = () => request(app.getHttpServer());

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    const config = new ConfigService({ JOB_DATABASE_URL: db.url, JWT_PUBLIC_KEY: publicKey });
    const module = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), TagsModule],
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

  it('migration ใส่ Tag ตั้งต้นให้ (NextJs, NestJs, Rust ...)', async () => {
    const res = await http().get('/v1/tags?page_size=100').expect(200);
    const body = res.body as Paginated<JobTag>;
    expect(body.data.map((t) => t.slug)).to.include.members(['nextjs', 'nestjs', 'rust']);
    for (const tag of body.data) expect(tag).to.have.all.keys('id', 'name', 'slug');
    expect(body.data.map((t) => t.name)).to.deep.equal([...body.data.map((t) => t.name)].sort((a, b) => a.localeCompare(b)));
  });

  it('GET /tags เป็น Public (ไม่ต้องมี token), ค้นชื่อได้ไม่สนตัวพิมพ์, ตั้ง Cache-Control', async () => {
    const res = await http().get('/v1/tags?q=NEXT').expect(200);
    expect((res.body as Paginated<JobTag>).data.map((t) => t.slug)).to.deep.equal(['nextjs']);
    expect(res.headers['cache-control']).to.equal('public, max-age=60');
    await http().get('/v1/tags?page_size=101').expect(400);
  });

  it('Admin เท่านั้น: ไม่มี token 401, HR/นักศึกษา 403', async () => {
    await http().get('/v1/admin/tags').expect(401);
    for (const role of ['COMPANY_HR', 'STUDENT', 'ADVISOR']) {
      const auth = { Authorization: `Bearer ${token(role)}` };
      await http().get('/v1/admin/tags').set(auth).expect(403);
      await http().post('/v1/admin/tags').set(auth).send({ name: 'X' }).expect(403);
      await http().patch(`/v1/admin/tags/${randomUUID()}`).set(auth).send({ active: false }).expect(403);
    }
  });

  it('POST สร้าง Tag (slug จากชื่อ), ชื่อซ้ำ/slug ซ้ำ 409, ชื่อไม่มีตัวอักษรอังกฤษ/ว่าง/ยาวเกิน 400', async () => {
    const created = await http().post('/v1/admin/tags').set(admin()).send({ name: '  Spring Boot ' }).expect(201);
    expect(created.body).to.include({ name: 'Spring Boot', slug: 'spring-boot', active: true, job_count: 0 });
    const dup = await http().post('/v1/admin/tags').set(admin()).send({ name: 'spring boot' }).expect(409);
    expect(dup.body.error.code).to.equal('STATE_CONFLICT');
    expect(dup.body.error.details[0].issue).to.equal('TAG_EXISTS');
    const thai = await http().post('/v1/admin/tags').set(admin()).send({ name: 'ภาษาไทย' }).expect(400);
    expect(thai.body.error.details[0].issue).to.equal('TAG_NAME_INVALID');
    await http().post('/v1/admin/tags').set(admin()).send({ name: '   ' }).expect(400);
    await http().post('/v1/admin/tags').set(admin()).send({ name: 'x'.repeat(51) }).expect(400);
    await http().post('/v1/admin/tags').set(admin()).send({}).expect(400);
    const row = await db.prisma.tag.findUniqueOrThrow({ where: { slug: 'spring-boot' } });
    expect(row.createdBy).to.be.a('string');
  });

  it('PATCH เปลี่ยนชื่อ (slug คงเดิม) และปิดใช้งาน: หายจาก GET /tags แต่ยังอยู่ใน GET /admin/tags และ job_count นับประกาศที่ติดอยู่', async () => {
    const tag = await db.prisma.tag.findUniqueOrThrow({ where: { slug: 'rust' } });
    const job = await seedJob(db.prisma, 'PUBLISHED');
    await db.prisma.jobTag.create({ data: { jobId: job.id, tagId: tag.id } });

    const renamed = await http().patch(`/v1/admin/tags/${tag.id}`).set(admin()).send({ name: 'Rust Lang' }).expect(200);
    expect(renamed.body).to.include({ name: 'Rust Lang', slug: 'rust', active: true, job_count: 1 });

    await http().patch(`/v1/admin/tags/${tag.id}`).set(admin()).send({ active: false }).expect(200);
    const pub = await http().get('/v1/tags?page_size=100').expect(200);
    expect((pub.body as Paginated<JobTag>).data.map((t) => t.slug)).to.not.include('rust');
    const adminList = await http().get('/v1/admin/tags?page_size=100').set(admin()).expect(200);
    const found = (adminList.body as Paginated<AdminTag>).data.find((t) => t.slug === 'rust');
    expect(found).to.include({ active: false, job_count: 1 });
    const inactive = await http().get('/v1/admin/tags?active=false').set(admin()).expect(200);
    expect((inactive.body as Paginated<AdminTag>).data.map((t) => t.slug)).to.deep.equal(['rust']);
  });

  it('PATCH: ไม่มีฟิลด์ 400, ไม่พบ 404, id ไม่ใช่ UUID 400, เปลี่ยนชื่อชนกับ Tag อื่น 409', async () => {
    await http().patch(`/v1/admin/tags/${randomUUID()}`).set(admin()).send({}).expect(400);
    await http().patch(`/v1/admin/tags/${randomUUID()}`).set(admin()).send({ active: true }).expect(404);
    await http().patch('/v1/admin/tags/not-a-uuid').set(admin()).send({ active: true }).expect(400);
    const react = await db.prisma.tag.findUniqueOrThrow({ where: { slug: 'react' } });
    const clash = await http().patch(`/v1/admin/tags/${react.id}`).set(admin()).send({ name: 'Python' }).expect(409);
    expect(clash.body.error.details[0].issue).to.equal('TAG_EXISTS');
  });

  it('DELETE ลบได้เฉพาะ Tag ที่ไม่มีประกาศใช้, ใช้อยู่ 409 TAG_IN_USE, ไม่พบ 404, ไม่ใช่ Admin 403', async () => {
    const unused = await http().post('/v1/admin/tags').set(admin()).send({ name: 'Kotlin Delete Test' }).expect(201);
    await http().delete(`/v1/admin/tags/${unused.body.id}`).set({ Authorization: `Bearer ${token('COMPANY_HR')}` }).expect(403);
    await http().delete(`/v1/admin/tags/${unused.body.id}`).set(admin()).expect(204);
    expect(await db.prisma.tag.count({ where: { id: unused.body.id } })).to.equal(0);
    await http().delete(`/v1/admin/tags/${unused.body.id}`).set(admin()).expect(404);
    await http().delete('/v1/admin/tags/not-a-uuid').set(admin()).expect(400);

    const used = await db.prisma.tag.findUniqueOrThrow({ where: { slug: 'react' } });
    const job = await seedJob(db.prisma, 'CLOSED');
    await db.prisma.jobTag.create({ data: { jobId: job.id, tagId: used.id } });
    const blocked = await http().delete(`/v1/admin/tags/${used.id}`).set(admin()).expect(409);
    expect(blocked.body.error.details[0].issue).to.equal('TAG_IN_USE');
    expect(await db.prisma.jobTag.count({ where: { tagId: used.id } })).to.equal(1);
  });
});
