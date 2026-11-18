import { randomUUID } from 'node:crypto';
import { Global, INestApplication, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { configureApp } from '@internpath/common';
import { expect } from 'chai';
import request from 'supertest';
import { S3StorageService } from '../../src/common/storage/s3-storage.service';
import { LifecycleConfigService } from '../../src/config/lifecycle-config.service';
import { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { ProfilesModule } from '../../src/modules/profiles/profiles.module';
import { ResumesModule } from '../../src/modules/resumes/resumes.module';
import { MAX_ACTIVE_RESUMES } from '../../src/modules/resumes/resumes.service';
import { PrismaService } from '../../src/prisma/prisma.service';
import { TEST_JWT, bearer } from '../support/jwt';
import { FakeIdentity, FakePrisma, FakeStorage, SAMPLE_FILES } from '../support/profile-resume-fakes';

const prisma = new FakePrisma();
const storage = new FakeStorage();
const identity = new FakeIdentity();
const SIGNED_URL_TTL = 600;

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: prisma },
    { provide: S3StorageService, useValue: storage },
    { provide: IdentityInternalClient, useValue: identity },
    { provide: LifecycleConfigService, useValue: { getNumber: async () => SIGNED_URL_TTL } },
  ],
  exports: [PrismaService, S3StorageService, IdentityInternalClient, LifecycleConfigService],
})
class FakeInfraModule {}

const UUID_PDF_KEY = /^resumes\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.pdf$/;

describe('Lifecycle 1.3 — โปรไฟล์และเรซูเม่ (api-contract §7.1)', () => {
  let app: INestApplication;
  const http = () => request(app.getHttpServer());

  const studentA = randomUUID();
  const studentB = randomUUID();
  const companyX = randomUUID();
  const companyY = randomUUID();
  const advisorA = randomUUID();
  const advisorOther = randomUUID();

  const asStudent = (sub = studentA) => bearer({ role: 'STUDENT', sub });
  const asHr = (company_id = companyX) => bearer({ role: 'COMPANY_HR', sub: randomUUID(), company_id, company_role: 'MEMBER' });
  const asAdvisor = (sub = advisorA) => bearer({ role: 'ADVISOR', sub });
  const asAdmin = () => bearer({ role: 'PLATFORM_ADMIN', sub: randomUUID() });

  before(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true, load: [() => ({ JWT_PUBLIC_KEY: TEST_JWT.publicKey })] }),
        FakeInfraModule,
        ProfilesModule,
        ResumesModule,
      ],
    }).compile();
    // ปิด log ของ Nest (error 5xx ที่ตั้งใจให้เกิดในเทสต์)
    app = moduleRef.createNestApplication({ logger: false });
    configureApp(app);
    await app.init();
  });

  after(async () => {
    await app?.close();
  });

  beforeEach(() => {
    prisma.profiles = [];
    prisma.resumes = [];
    prisma.applications = [];
    prisma.failResumeCreate = false;
    storage.objects.clear();
    storage.deleted = [];
    storage.signed = [];
    storage.failDelete = false;
    identity.students.clear();
    identity.consents.clear();
    identity.consentCalls = [];
    identity.unavailable = false;
    identity.setStudent(studentA, { major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });
    identity.setStudent(studentB, { major: 'บัญชี', year_level: 2 });
  });

  // ------------------------------------------------------------------
  describe('Guard สิทธิ์ (JwtAuthGuard + RolesGuard, UAT-29)', () => {
    const anyId = randomUUID();
    const endpoints: Array<[string, string]> = [
      ['get', '/v1/me/profile'],
      ['put', '/v1/me/profile'],
      ['get', '/v1/me/resumes'],
      ['post', '/v1/me/resumes'],
      ['delete', `/v1/me/resumes/${anyId}`],
      ['get', `/v1/hr/applications/${anyId}/resume`],
      ['get', `/v1/advisor/applications/${anyId}/resume`],
    ];

    it('ไม่มี Token ⇒ 401 UNAUTHENTICATED ทุก endpoint', async () => {
      for (const [method, path] of endpoints) {
        const res = await (http() as any)[method](path).expect(401);
        expect(res.body.error.code, `${method} ${path}`).to.equal('UNAUTHENTICATED');
      }
    });

    it('Token หมดอายุ ⇒ 401 TOKEN_EXPIRED • Token เซ็นด้วยคีย์อื่น ⇒ 401 UNAUTHENTICATED', async () => {
      const expired = await http().get('/v1/me/profile').set('Authorization', bearer({ role: 'STUDENT', sub: studentA }, -10)).expect(401);
      expect(expired.body.error.code).to.equal('TOKEN_EXPIRED');
      const forged = await http().get('/v1/me/profile').set('Authorization', 'Bearer eyJhbGciOiJIUzI1NiJ9.e30.x').expect(401);
      expect(forged.body.error.code).to.equal('UNAUTHENTICATED');
    });

    it('Role ไม่ตรง ⇒ 403 FORBIDDEN_ROLE (ครบ 4 Role)', async () => {
      const cases: Array<[string, string, string]> = [
        ['STUDENT → HR', `/v1/hr/applications/${anyId}/resume`, asStudent()],
        ['STUDENT → Advisor', `/v1/advisor/applications/${anyId}/resume`, asStudent()],
        ['HR → /me/profile', '/v1/me/profile', asHr()],
        ['HR → /me/resumes', '/v1/me/resumes', asHr()],
        ['HR → Advisor', `/v1/advisor/applications/${anyId}/resume`, asHr()],
        ['ADVISOR → /me/resumes', '/v1/me/resumes', asAdvisor()],
        ['ADVISOR → HR', `/v1/hr/applications/${anyId}/resume`, asAdvisor()],
        // Admin ดูเรซูเม่ได้เฉพาะเคสที่ถูกยกระดับ (README §5.11) — ไม่ผ่าน endpoint ของ §7.1
        ['ADMIN → /me/resumes', '/v1/me/resumes', asAdmin()],
        ['ADMIN → HR', `/v1/hr/applications/${anyId}/resume`, asAdmin()],
        ['ADMIN → Advisor', `/v1/advisor/applications/${anyId}/resume`, asAdmin()],
      ];
      for (const [label, path, token] of cases) {
        const res = await http().get(path).set('Authorization', token);
        expect(res.status, label).to.equal(403);
        expect(res.body.error.code, label).to.equal('FORBIDDEN_ROLE');
      }
    });
  });

  // ------------------------------------------------------------------
  describe('GET/PUT /me/profile', () => {
    it('ครั้งแรก ⇒ สร้างโปรไฟล์จากสำเนา major/year_level ของ Identity', async () => {
      const res = await http().get('/v1/me/profile').set('Authorization', asStudent()).expect(200);
      expect(res.body).to.deep.equal({ skills: [], major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });
      expect(prisma.profiles).to.have.length(1);
      expect(prisma.profiles[0].userId).to.equal(studentA);
    });

    it('PUT แทนที่ฟิลด์ที่แก้ได้ ตัดช่องว่าง/สกิลซ้ำ และรีเฟรช major จาก Identity', async () => {
      await http().get('/v1/me/profile').set('Authorization', asStudent()).expect(200);
      identity.setStudent(studentA, { major: 'วิทยาการข้อมูล', year_level: 4 });

      const res = await http()
        .put('/v1/me/profile')
        .set('Authorization', asStudent())
        .send({ headline: '  Backend Intern  ', skills: ['NestJS', 'nestjs', ' SQL '], bio: 'ชอบเขียนเทสต์', portfolio_url: 'https://example.com/me' })
        .expect(200);
      expect(res.body).to.deep.equal({
        headline: 'Backend Intern',
        skills: ['NestJS', 'SQL'],
        bio: 'ชอบเขียนเทสต์',
        portfolio_url: 'https://example.com/me',
        major: 'วิทยาการข้อมูล',
        year_level: 4,
      });

      // PUT รอบถัดไปที่ไม่ส่งฟิลด์ ⇒ ล้างค่า
      const cleared = await http().put('/v1/me/profile').set('Authorization', asStudent()).send({}).expect(200);
      expect(cleared.body).to.deep.equal({ skills: [], major: 'วิทยาการข้อมูล', year_level: 4 });
    });

    it('ห้ามส่ง major/year_level เอง และตรวจรูปแบบข้อมูล ⇒ 400 VALIDATION_FAILED', async () => {
      const bad = [
        { major: 'แพทย์' },
        { year_level: 9 },
        { portfolio_url: 'javascript:alert(1)' },
        { portfolio_url: 'not a url' },
        { skills: 'NestJS' },
        { skills: Array.from({ length: 31 }, (_, i) => `s${i}`) },
        { skills: ['x'.repeat(51)] },
        { headline: 'x'.repeat(201) },
        { bio: 'x'.repeat(2001) },
      ];
      for (const body of bad) {
        const res = await http().put('/v1/me/profile').set('Authorization', asStudent()).send(body);
        expect(res.status, JSON.stringify(body).slice(0, 60)).to.equal(400);
        expect(res.body.error.code).to.equal('VALIDATION_FAILED');
      }
      expect(prisma.profiles).to.have.length(0);
    });

    it('แยกข้อมูลตามเจ้าของ Token — นักศึกษาคนอื่นเห็นแค่โปรไฟล์ตัวเอง', async () => {
      await http().put('/v1/me/profile').set('Authorization', asStudent(studentA)).send({ headline: 'A' }).expect(200);
      const b = await http().get('/v1/me/profile').set('Authorization', asStudent(studentB)).expect(200);
      expect(b.body).to.deep.equal({ skills: [], major: 'บัญชี', year_level: 2 });
    });

    it('Identity ล่ม: มีโปรไฟล์แล้ว ⇒ แก้ได้โดยคงสำเนาเดิม • ยังไม่มีโปรไฟล์ ⇒ 502 UPSTREAM_UNAVAILABLE', async () => {
      await http().get('/v1/me/profile').set('Authorization', asStudent()).expect(200);
      identity.unavailable = true;
      const res = await http().put('/v1/me/profile').set('Authorization', asStudent()).send({ headline: 'ยังแก้ได้' }).expect(200);
      expect(res.body).to.include({ headline: 'ยังแก้ได้', major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });

      const fresh = await http().get('/v1/me/profile').set('Authorization', asStudent(studentB)).expect(502);
      expect(fresh.body.error.code).to.equal('UPSTREAM_UNAVAILABLE');
      const freshPut = await http().put('/v1/me/profile').set('Authorization', asStudent(studentB)).send({}).expect(502);
      expect(freshPut.body.error.code).to.equal('UPSTREAM_UNAVAILABLE');
    });

    it('ไม่พบนักศึกษาใน Identity ⇒ 404 NOT_FOUND', async () => {
      const res = await http().get('/v1/me/profile').set('Authorization', asStudent(randomUUID())).expect(404);
      expect(res.body.error.code).to.equal('NOT_FOUND');
    });
  });

  // ------------------------------------------------------------------
  describe('POST/GET/DELETE /me/resumes', () => {
    const upload = (buffer: Buffer, filename = 'cv.pdf', token = asStudent(), field = 'file') =>
      http().post('/v1/me/resumes').set('Authorization', token).attach(field, buffer, { filename, contentType: 'application/pdf' });

    it('อัปโหลด PDF ⇒ 201 + Signed URL; Key เป็น UUID ไม่มีชื่อไฟล์เดิม; ไม่ส่ง object_key ออก', async () => {
      const res = await upload(SAMPLE_FILES.pdf(), 'สมชาย ใจดี resume.pdf').expect(201);
      expect(res.body).to.have.keys(['id', 'size_bytes', 'is_primary', 'url', 'uploaded_at']);
      expect(res.body.is_primary).to.equal(true);
      expect(res.body.size_bytes).to.equal(SAMPLE_FILES.pdf().length);
      expect(JSON.stringify(res.body)).to.not.include('object_key');

      const row = prisma.resumes[0];
      expect(row.studentUserId).to.equal(studentA);
      expect(row.objectKey).to.match(UUID_PDF_KEY);
      expect(row.objectKey).to.not.include('สมชาย');
      expect(storage.objects.has(row.objectKey)).to.equal(true);
      expect(storage.signed.at(-1)).to.deep.equal({ key: row.objectKey, ttl: SIGNED_URL_TTL });
      expect(prisma.executeRawCalls).to.be.greaterThan(0);

      const second = await upload(SAMPLE_FILES.pdf()).expect(201);
      expect(second.body.is_primary).to.equal(false);
    });

    it('UAT-42: .exe ที่เปลี่ยนนามสกุลเป็น .pdf ⇒ 400 FILE_TYPE_NOT_ALLOWED และไม่เขียนลง Storage', async () => {
      const res = await upload(SAMPLE_FILES.exe(), 'cv.pdf').expect(400);
      expect(res.body.error.code).to.equal('FILE_TYPE_NOT_ALLOWED');
      expect(storage.objects.size).to.equal(0);
      expect(prisma.resumes).to.have.length(0);
    });

    it('UAT-42: ไฟล์ > 5 MB ⇒ 400 FILE_TOO_LARGE และไม่เขียนลง Storage', async () => {
      const res = await upload(SAMPLE_FILES.oversizedPdf()).expect(400);
      expect(res.body.error.code).to.equal('FILE_TOO_LARGE');
      expect(storage.objects.size).to.equal(0);
    });

    it('ไม่แนบไฟล์ / ชื่อฟิลด์ผิด ⇒ 400 VALIDATION_FAILED', async () => {
      const none = await http().post('/v1/me/resumes').set('Authorization', asStudent()).expect(400);
      expect(none.body.error.code).to.equal('VALIDATION_FAILED');
      const wrongField = await upload(SAMPLE_FILES.pdf(), 'cv.pdf', asStudent(), 'resume').expect(400);
      expect(wrongField.body.error.code).to.equal('VALIDATION_FAILED');
    });

    it('บันทึก DB ล้มหลังอัปโหลด ⇒ ลบไฟล์ชดเชย (ไม่ทิ้งไฟล์กำพร้า)', async () => {
      prisma.failResumeCreate = true;
      await upload(SAMPLE_FILES.pdf()).expect(500);
      expect(storage.objects.size).to.equal(0);
      expect(storage.deleted).to.have.length(1);
    });

    it('GET เห็นเฉพาะของตัวเองที่ยังไม่ลบ เรียงไฟล์หลักก่อน พร้อม data/meta', async () => {
      const old = prisma.addResume({ studentUserId: studentA, isPrimary: true, uploadedAt: new Date('2026-11-01T00:00:00Z') });
      const newer = prisma.addResume({ studentUserId: studentA, uploadedAt: new Date('2026-11-10T00:00:00Z') });
      prisma.addResume({ studentUserId: studentA, deletedAt: new Date() });
      prisma.addResume({ studentUserId: studentB, isPrimary: true });

      const res = await http().get('/v1/me/resumes').set('Authorization', asStudent()).expect(200);
      expect(res.body.meta).to.deep.equal({ page: 1, page_size: 20, total: 2 });
      expect(res.body.data.map((r: { id: string }) => r.id)).to.deep.equal([old.id, newer.id]);
      expect(res.body.data[0]).to.include({ is_primary: true, uploaded_at: '2026-11-01T00:00:00.000Z' });
      expect(res.body.data[0].url).to.be.a('string');

      const paged = await http().get('/v1/me/resumes?page=2&page_size=1').set('Authorization', asStudent()).expect(200);
      expect(paged.body.data.map((r: { id: string }) => r.id)).to.deep.equal([newer.id]);
      await http().get('/v1/me/resumes?page_size=101').set('Authorization', asStudent()).expect(400);
    });

    it('DELETE ⇒ 204 ลบไฟล์ใน Storage + soft-delete และตั้งไฟล์ล่าสุดที่เหลือเป็นไฟล์หลัก', async () => {
      const primary = prisma.addResume({ studentUserId: studentA, isPrimary: true, uploadedAt: new Date('2026-11-01T00:00:00Z') });
      const a = prisma.addResume({ studentUserId: studentA, uploadedAt: new Date('2026-11-02T00:00:00Z') });
      const b = prisma.addResume({ studentUserId: studentA, uploadedAt: new Date('2026-11-03T00:00:00Z') });

      await http().delete(`/v1/me/resumes/${primary.id}`).set('Authorization', asStudent()).expect(204);
      expect(storage.deleted).to.deep.equal([primary.objectKey]);
      expect(primary.deletedAt).to.be.instanceOf(Date);
      expect(primary.isPrimary).to.equal(false);
      expect(b.isPrimary).to.equal(true);
      expect(a.isPrimary).to.equal(false);

      const again = await http().delete(`/v1/me/resumes/${primary.id}`).set('Authorization', asStudent()).expect(404);
      expect(again.body.error.code).to.equal('NOT_FOUND');
    });

    it('DELETE เรซูเม่ของนักศึกษาคนอื่น ⇒ 404 (ไม่บอกว่ามีอยู่) และไม่แตะไฟล์', async () => {
      const other = prisma.addResume({ studentUserId: studentB, isPrimary: true });
      await http().delete(`/v1/me/resumes/${other.id}`).set('Authorization', asStudent(studentA)).expect(404);
      expect(storage.deleted).to.have.length(0);
      expect(other.deletedAt).to.equal(null);
      await http().delete('/v1/me/resumes/not-a-uuid').set('Authorization', asStudent()).expect(400);
    });

    it(`เพดาน ${MAX_ACTIVE_RESUMES} ไฟล์: ไฟล์ถัดไป ⇒ 400 VALIDATION_FAILED + RESUME_LIMIT_REACHED และไม่เขียนลง Storage`, async () => {
      for (let i = 0; i < MAX_ACTIVE_RESUMES; i += 1) prisma.addResume({ studentUserId: studentA, isPrimary: i === 0 });
      prisma.addResume({ studentUserId: studentA, deletedAt: new Date() }); // ไฟล์ที่ลบแล้วไม่นับ
      prisma.addResume({ studentUserId: studentB }); // ของคนอื่นไม่นับ

      const res = await upload(SAMPLE_FILES.pdf()).expect(400);
      expect(res.body.error.code).to.equal('VALIDATION_FAILED');
      expect(res.body.error.details).to.deep.equal([{ field: 'file', issue: 'RESUME_LIMIT_REACHED' }]);
      expect(storage.objects.size).to.equal(0);

      // ลบออก 1 ไฟล์ ⇒ อัปโหลดได้อีก
      const first = prisma.resumes.find((r) => r.studentUserId === studentA && !r.deletedAt)!;
      await http().delete(`/v1/me/resumes/${first.id}`).set('Authorization', asStudent()).expect(204);
      await upload(SAMPLE_FILES.pdf()).expect(201);
      expect(prisma.resumes.filter((r) => r.studentUserId === studentA && !r.deletedAt)).to.have.length(MAX_ACTIVE_RESUMES);
    });

    it('DELETE ใช้ advisory lock เดียวกับ upload ใน Transaction', async () => {
      const resume = prisma.addResume({ studentUserId: studentA, isPrimary: true });
      const before = prisma.executeRawCalls;
      await http().delete(`/v1/me/resumes/${resume.id}`).set('Authorization', asStudent()).expect(204);
      expect(prisma.executeRawCalls).to.equal(before + 1);
    });

    it('DELETE: ลบไฟล์ใน Storage ไม่สำเร็จ ⇒ error และยังไม่ mark ว่าลบ (ลองใหม่ได้)', async () => {
      const resume = prisma.addResume({ studentUserId: studentA, isPrimary: true });
      storage.failDelete = true;
      await http().delete(`/v1/me/resumes/${resume.id}`).set('Authorization', asStudent()).expect(500);
      expect(resume.deletedAt).to.equal(null);
    });
  });

  // ------------------------------------------------------------------
  describe('GET /hr/applications/{id}/resume และ /advisor/applications/{id}/resume', () => {
    function seed(overrides: Record<string, unknown> = {}) {
      const resume = prisma.addResume({ studentUserId: studentA, isPrimary: true });
      const application = prisma.addApplication({
        studentUserId: studentA,
        companyId: companyX,
        advisorUserId: advisorA,
        resumeId: resume.id,
        ...overrides,
      });
      return { resume, application };
    }

    it('HR บริษัทที่ถูกสมัคร + มี Consent ⇒ 200 {url, expires_at ~ +10 นาที}', async () => {
      const { resume, application } = seed();
      identity.consents.add(`${studentA}:${companyX}`);
      const before = Date.now();
      const res = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyX)).expect(200);
      expect(res.body).to.have.keys(['url', 'expires_at']);
      const expiresAt = Date.parse(res.body.expires_at);
      expect(expiresAt - before).to.be.within(SIGNED_URL_TTL * 1000 - 1000, SIGNED_URL_TTL * 1000 + 5000);
      expect(storage.signed.at(-1)).to.deep.equal({ key: resume.objectKey, ttl: SIGNED_URL_TTL });
      expect(identity.consentCalls).to.deep.equal([{ student: studentA, company: companyX }]);
    });

    it('HR บริษัทอื่น ⇒ 403 NOT_OWNER_OF_RESOURCE (ไม่ถาม Consent และไม่ออก URL)', async () => {
      const { application } = seed();
      identity.consents.add(`${studentA}:${companyY}`);
      const res = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyY)).expect(403);
      expect(res.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
      expect(identity.consentCalls).to.have.length(0);
      expect(storage.signed).to.have.length(0);
    });

    it('HR ไม่มี company_id ใน Token ⇒ 403 NOT_OWNER_OF_RESOURCE', async () => {
      const { application } = seed();
      const token = bearer({ role: 'COMPANY_HR', sub: randomUUID() });
      const res = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', token).expect(403);
      expect(res.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
    });

    it('ไม่มี Consent ⇒ 403 CONSENT_REQUIRED', async () => {
      const { application } = seed();
      const res = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyX)).expect(403);
      expect(res.body.error.code).to.equal('CONSENT_REQUIRED');
      expect(storage.signed).to.have.length(0);
    });

    it('Identity ล่มตอนตรวจ Consent ⇒ 502 UPSTREAM_UNAVAILABLE (fail-closed)', async () => {
      const { application } = seed();
      identity.unavailable = true;
      const res = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyX)).expect(502);
      expect(res.body.error.code).to.equal('UPSTREAM_UNAVAILABLE');
      expect(storage.signed).to.have.length(0);
    });

    it('ใบสมัครไม่มี / ไม่มีเรซูเม่ / เรซูเม่ไม่ใช่ของเจ้าของใบสมัคร ⇒ 404 NOT_FOUND ไม่มี details', async () => {
      identity.consents.add(`${studentA}:${companyX}`);
      const missing = await http().get(`/v1/hr/applications/${randomUUID()}/resume`).set('Authorization', asHr()).expect(404);
      expect(missing.body.error.code).to.equal('NOT_FOUND');
      expect(missing.body.error.details).to.equal(undefined);

      const noResume = prisma.addApplication({ studentUserId: studentA, companyId: companyX, advisorUserId: advisorA });
      const none = await http().get(`/v1/hr/applications/${noResume.id}/resume`).set('Authorization', asHr()).expect(404);
      expect(none.body.error.details).to.equal(undefined);

      const foreign = prisma.addResume({ studentUserId: studentB });
      const mismatched = prisma.addApplication({ studentUserId: studentA, companyId: companyX, advisorUserId: advisorA, resumeId: foreign.id });
      const mis = await http().get(`/v1/hr/applications/${mismatched.id}/resume`).set('Authorization', asHr()).expect(404);
      expect(mis.body.error.details).to.equal(undefined);
      // เรซูเม่ของคนอื่นที่ถูกลบ ก็ยังเป็น 404 เฉยๆ (ไม่บอกว่าเคยมี)
      foreign.deletedAt = new Date();
      const misDeleted = await http().get(`/v1/hr/applications/${mismatched.id}/resume`).set('Authorization', asHr()).expect(404);
      expect(misDeleted.body.error.details).to.equal(undefined);

      await http().get('/v1/hr/applications/not-a-uuid/resume').set('Authorization', asHr()).expect(400);
    });

    it('นักศึกษาลบเรซูเม่ของใบสมัครแล้ว ⇒ HR/อาจารย์ได้ 404 NOT_FOUND + RESUME_DELETED_BY_STUDENT และไม่ออก URL', async () => {
      identity.consents.add(`${studentA}:${companyX}`);
      const { resume, application } = seed();
      await http().delete(`/v1/me/resumes/${resume.id}`).set('Authorization', asStudent(studentA)).expect(204);

      const hr = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyX)).expect(404);
      expect(hr.body.error.code).to.equal('NOT_FOUND');
      expect(hr.body.error.details).to.deep.equal([{ field: 'resume', issue: 'RESUME_DELETED_BY_STUDENT' }]);

      const adv = await http().get(`/v1/advisor/applications/${application.id}/resume`).set('Authorization', asAdvisor(advisorA)).expect(404);
      expect(adv.body.error.code).to.equal('NOT_FOUND');
      expect(adv.body.error.details).to.deep.equal([{ field: 'resume', issue: 'RESUME_DELETED_BY_STUDENT' }]);
      expect(storage.signed).to.have.length(0);
    });

    it('เรซูเม่ถูกลบแต่ผู้เรียกไม่มีสิทธิ์ ⇒ ยังเป็น 403 ก่อน (ไม่เปิดเผยว่านักศึกษาลบ)', async () => {
      const { resume, application } = seed();
      resume.deletedAt = new Date();
      const hr = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyY)).expect(403);
      expect(hr.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
      const adv = await http().get(`/v1/advisor/applications/${application.id}/resume`).set('Authorization', asAdvisor(advisorOther)).expect(403);
      expect(adv.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
    });

    it('HR บริษัทเดียวกันแต่ไม่มี Consent + เรซูเม่ถูกลบ ⇒ 403 CONSENT_REQUIRED (ไม่ใช่ 404 RESUME_DELETED_BY_STUDENT)', async () => {
      const { resume, application } = seed();
      resume.deletedAt = new Date();
      const res = await http().get(`/v1/hr/applications/${application.id}/resume`).set('Authorization', asHr(companyX)).expect(403);
      expect(res.body.error.code).to.equal('CONSENT_REQUIRED');
      expect(JSON.stringify(res.body)).to.not.include('RESUME_DELETED_BY_STUDENT');
      expect(identity.consentCalls).to.deep.equal([{ student: studentA, company: companyX }]);
      expect(storage.signed).to.have.length(0);
    });

    it('อาจารย์ที่ผูกกับใบสมัคร ⇒ 200 (ไม่ต้องใช้ Consent ของบริษัท)', async () => {
      const { resume, application } = seed();
      const res = await http().get(`/v1/advisor/applications/${application.id}/resume`).set('Authorization', asAdvisor(advisorA)).expect(200);
      expect(res.body).to.have.keys(['url', 'expires_at']);
      expect(storage.signed.at(-1)?.key).to.equal(resume.objectKey);
      expect(identity.consentCalls).to.have.length(0);
    });

    it('อาจารย์นอกความดูแล / ใบสมัครยังไม่มีอาจารย์ ⇒ 403 NOT_OWNER_OF_RESOURCE', async () => {
      const { application } = seed();
      const other = await http().get(`/v1/advisor/applications/${application.id}/resume`).set('Authorization', asAdvisor(advisorOther)).expect(403);
      expect(other.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');

      const { application: unlinked } = seed({ advisorUserId: null });
      const none = await http().get(`/v1/advisor/applications/${unlinked.id}/resume`).set('Authorization', asAdvisor(advisorA)).expect(403);
      expect(none.body.error.code).to.equal('NOT_OWNER_OF_RESOURCE');
      expect(storage.signed).to.have.length(0);
    });
  });
});
