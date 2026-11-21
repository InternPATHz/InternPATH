import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { OutboxWriter, configureApp } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';
import { LifecycleConfigModule } from '../../src/config/lifecycle-config.module';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { InternalModule } from '../../src/internal/internal.module';
import { JobInternalClient } from '../../src/internal/job-client.service';
import { HrApplicationsModule } from '../../src/modules/hr-applications/hr-applications.module';
import { PHOTO_MAX_BYTES } from '../../src/modules/profiles/photo-file';
import { ProfilesModule } from '../../src/modules/profiles/profiles.module';
import { PrismaModule } from '../../src/prisma/prisma.module';
import { PrismaService } from '../../src/prisma/prisma.service';
import { FakeJobClient } from '../support/application-fakes';
import { createTestDatabase, type TestDatabase } from '../support/db';
import { ALL_CATEGORIES, TEST_JWT, bearer } from '../support/jwt';
import { sampleJpeg, samplePng } from '../support/photo-samples';
import { FakeIdentity, FakeStorage, SAMPLE_FILES } from '../support/profile-resume-fakes';

const storage = new FakeStorage();

@Global()
@Module({
  providers: [OutboxWriter, { provide: S3StorageService, useValue: storage }],
  exports: [OutboxWriter, S3StorageService],
})
class TestGlobalsModule {}

const PHOTO_KEY = /^profile-photos\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

/*
 * รูปโปรไฟล์นักศึกษา (api-contract §7.1 / §7.3, data-schema §6 — PM ตัดสิน 2026-11-18) ผ่าน HTTP + Postgres จริง
 * Storage/Identity เป็นตัวปลอม
 */
describe('Lifecycle — รูปโปรไฟล์นักศึกษา (HTTP + Postgres จริง)', function () {
  this.timeout(120_000);
  let database: TestDatabase | undefined;
  let app: INestApplication;
  let prisma: PrismaService;
  const identity = new FakeIdentity();
  const http = () => request(app.getHttpServer());

  let student: string;
  let companyId: string;
  const asStudent = (sub = student) => bearer({ role: 'STUDENT', sub });
  const asHr = () => bearer({ role: 'COMPANY_HR', sub: randomUUID(), company_id: companyId, company_role: 'MEMBER', company_categories: ALL_CATEGORIES });

  before(async function () {
    database = await createTestDatabase('lc_photo');
    if (!database) this.skip();
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => ({ JWT_PUBLIC_KEY: TEST_JWT.publicKey, LIFECYCLE_DATABASE_URL: database!.url })],
        }),
        PrismaModule,
        LifecycleConfigModule,
        InternalModule,
        TestGlobalsModule,
        ProfilesModule,
        HrApplicationsModule,
      ],
    })
      .overrideProvider(IdentityInternalClient)
      .useValue(identity)
      .overrideProvider(JobInternalClient)
      .useValue(new FakeJobClient())
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
    prisma = app.get(PrismaService);
  });

  after(async () => {
    await app?.close();
    await database?.drop();
  });

  beforeEach(() => {
    storage.objects.clear();
    storage.deleted = [];
    storage.signed = [];
    storage.failDelete = false;
    identity.students.clear();
    identity.consents.clear();
    identity.unavailable = false;
    student = randomUUID();
    companyId = randomUUID();
    identity.setStudent(student, { major: 'CS', year_level: 3 });
  });

  const upload = (buffer: Buffer, filename = 'me.jpg', token = asStudent()) =>
    http().put('/v1/me/profile/photo').set('Authorization', token).attach('file', buffer, filename);
  const photoKey = async () => (await prisma.studentProfile.findUnique({ where: { userId: student } }))?.photoKey ?? null;

  it('PUT ⇒ 200 {photo_url} (Signed URL) • เก็บใน Private bucket ด้วย key สุ่ม และล้าง metadata แล้ว • สร้างโปรไฟล์ให้ถ้ายังไม่มี', async () => {
    const res = await upload(sampleJpeg()).expect(200);
    expect(Object.keys(res.body)).to.deep.equal(['photo_url']);
    const key = await photoKey();
    expect(key).to.match(PHOTO_KEY);
    expect(res.body.photo_url).to.include(key).and.include('X-Amz-Expires=600');
    const stored = storage.objects.get(key as string) as Buffer;
    expect(stored.toString('latin1')).to.not.match(/SECRET-(GPS|TEXT)/);

    const profile = await http().get('/v1/me/profile').set('Authorization', asStudent()).expect(200);
    expect(profile.body.photo_url).to.include(key);
    expect(JSON.stringify(profile.body)).to.not.include('photo_key');
  });

  it('PUT ซ้ำ ⇒ แทนที่รูปเดิมและลบไฟล์เก่า • DELETE ⇒ 204 ลบไฟล์ + ล้าง key • DELETE ซ้ำ ⇒ 204 (idempotent)', async () => {
    await upload(sampleJpeg()).expect(200);
    const first = await photoKey();
    await upload(samplePng(), 'me.png').expect(200);
    const second = await photoKey();
    expect(second).to.match(/\.png$/).and.not.equal(first);
    expect(storage.deleted).to.deep.equal([first]);
    expect(storage.objects.has(first as string)).to.equal(false);

    await http().delete('/v1/me/profile/photo').set('Authorization', asStudent()).expect(204);
    expect(await photoKey()).to.equal(null);
    expect(storage.deleted).to.deep.equal([first, second]);
    await http().delete('/v1/me/profile/photo').set('Authorization', asStudent()).expect(204);
    const profile = await http().get('/v1/me/profile').set('Authorization', asStudent()).expect(200);
    expect(profile.body).to.not.have.property('photo_url');
  });

  it('PUT /me/profile ไม่รับ/ไม่เปลี่ยนรูป (เปลี่ยนผ่าน endpoint รูปเท่านั้น)', async () => {
    await upload(sampleJpeg()).expect(200);
    const key = await photoKey();
    await http().put('/v1/me/profile').set('Authorization', asStudent()).send({ skills: ['SQL'] }).expect(200);
    expect(await photoKey()).to.equal(key);
  });

  it('ชนิด/ขนาดผิด ⇒ 400 FILE_TYPE_NOT_ALLOWED / FILE_TOO_LARGE / VALIDATION_FAILED (ไม่มีไฟล์ค้าง) • Role อื่น ⇒ 403', async () => {
    expect((await upload(SAMPLE_FILES.pdf(), 'x.jpg').expect(400)).body.error.code).to.equal('FILE_TYPE_NOT_ALLOWED');
    expect((await upload(SAMPLE_FILES.exe(), 'x.png').expect(400)).body.error.code).to.equal('FILE_TYPE_NOT_ALLOWED');
    const big = Buffer.concat([sampleJpeg(), Buffer.alloc(PHOTO_MAX_BYTES)]);
    expect((await upload(big).expect(400)).body.error.code).to.equal('FILE_TOO_LARGE');
    const none = await http().put('/v1/me/profile/photo').set('Authorization', asStudent()).expect(400);
    expect(none.body.error.code).to.equal('VALIDATION_FAILED');
    expect(storage.objects.size).to.equal(0);

    expect((await upload(sampleJpeg(), 'a.jpg', asHr()).expect(403)).body.error.code).to.equal('FORBIDDEN_ROLE');
    await http().put('/v1/me/profile/photo').attach('file', sampleJpeg(), 'a.jpg').expect(401);
  });

  it('Storage ลบไม่ได้ตอน DELETE ⇒ error และยังคงรูปเดิม', async () => {
    await upload(sampleJpeg()).expect(200);
    const key = await photoKey();
    storage.failDelete = true;
    await http().delete('/v1/me/profile/photo').set('Authorization', asStudent()).expect(500);
    expect(await photoKey()).to.equal(key);
  });

  describe('ฝั่ง HR (api-contract §7.3)', () => {
    const seedApplication = async () => {
      const jobId = randomUUID();
      await prisma.jobSnapshot.create({ data: { jobId, companyId, title: 'x', status: 'PUBLISHED', category: 'TECH_IT' } });
      return prisma.application.create({ data: { jobId, companyId, studentUserId: student, status: 'PENDING' } });
    };

    it('รายละเอียด: profile.photo_url เฉพาะเมื่อมี Consent • ไม่มี Consent ⇒ ไม่มีรูป • รายการ HR ไม่มีรูปเด็ดขาด', async () => {
      await upload(sampleJpeg()).expect(200);
      const key = (await photoKey()) as string;
      const app1 = await seedApplication();

      const without = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(without.body).to.not.have.property('profile');
      expect(JSON.stringify(without.body)).to.not.include(key);

      identity.consents.add(`${student}:${companyId}`);
      const detail = await http().get(`/v1/hr/applications/${app1.id}`).set('Authorization', asHr()).expect(200);
      expect(detail.body.profile.photo_url).to.include(key);

      const list = await http().get('/v1/hr/applications').set('Authorization', asHr()).expect(200);
      expect(list.body.data).to.have.length(1);
      expect(JSON.stringify(list.body)).to.not.include('photo').and.not.include(key);
    });
  });
});
