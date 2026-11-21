import type { CategoryScopeService } from '../../src/common/auth/category-scope.service';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { expect } from 'chai';
import { Client } from 'pg';
import { PrismaClient } from '../../generated/client';
import type { S3StorageService } from '../../src/common/storage/s3-storage.service';
import type { LifecycleConfigService } from '../../src/config/lifecycle-config.service';
import type { IdentityInternalClient } from '../../src/internal/identity-client.service';
import { ProfilesService } from '../../src/modules/profiles/profiles.service';
import { AppException } from '@internpath/common';
import { MAX_ACTIVE_RESUMES, ResumesService } from '../../src/modules/resumes/resumes.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { FakeIdentity, FakeStorage, SAMPLE_FILES } from '../support/profile-resume-fakes';

/*
 * เทสต์ query ของ 1.3 บน Postgres จริง (ข้ามเมื่อไม่มีฐาน — เหมือน schema.spec.ts)
 * หมายเหตุ: โครงสร้างฐานชั่วคราวคัดลอกจาก schema.spec.ts — เมื่อ 1.2 (test/support/db.ts) merge แล้วให้ย้ายไปใช้ helper นั้น
 */
const APP_ROOT = path.resolve(__dirname, '../..');
const ROOT_ENV = path.resolve(APP_ROOT, '../../.env');

function adminUrl(): string | undefined {
  const override = process.env.LIFECYCLE_IT_ADMIN_URL;
  if (override) return override;
  if (!existsSync(ROOT_ENV)) return undefined;
  const line = readFileSync(ROOT_ENV, 'utf8')
    .split(/\r?\n/)
    .find((value) => value.startsWith('LIFECYCLE_DIRECT_URL='));
  if (!line) return undefined;
  const url = new URL(line.slice('LIFECYCLE_DIRECT_URL='.length).replace(/^"|"$/g, ''));
  url.pathname = '/postgres';
  return url.toString();
}

describe('Lifecycle 1.3 — โปรไฟล์/เรซูเม่บน Postgres จริง', function () {
  this.timeout(90_000);
  let admin: Client;
  let dbName: string;
  let prisma: PrismaClient;
  let storage: FakeStorage;
  let identity: FakeIdentity;
  let profiles: ProfilesService;
  let resumes: ResumesService;

  before(async function () {
    const base = adminUrl();
    if (!base) this.skip();
    admin = new Client({ connectionString: base, connectionTimeoutMillis: 2000 });
    try {
      await admin.connect();
      await admin.query('SELECT 1');
    } catch {
      await admin.end().catch(() => undefined);
      this.skip();
    }

    dbName = `lc_it_${randomBytes(4).toString('hex')}`;
    await admin.query(`CREATE DATABASE ${dbName}`);
    const dbUrl = new URL(base);
    dbUrl.pathname = `/${dbName}`;
    const url = dbUrl.toString();
    execFileSync(process.execPath, [require.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: APP_ROOT,
      env: { ...process.env, LIFECYCLE_DATABASE_URL: url, LIFECYCLE_DIRECT_URL: url },
      stdio: 'pipe',
    });
    prisma = new PrismaClient({ datasourceUrl: url });
  });

  after(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    if (dbName && admin) await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end().catch(() => undefined);
  });

  beforeEach(() => {
    storage = new FakeStorage();
    identity = new FakeIdentity();
    const db = prisma as unknown as PrismaService;
    const config = { getNumber: async () => 600 } as unknown as LifecycleConfigService;
    profiles = new ProfilesService(db, identity as unknown as IdentityInternalClient, storage as unknown as S3StorageService, config);
    resumes = new ResumesService(db, storage as unknown as S3StorageService, config, identity as unknown as IdentityInternalClient, { assertInScope: async () => undefined } as unknown as CategoryScopeService);
  });

  it('สร้าง/แก้โปรไฟล์ (text[] skills, ล้างค่า) และรีเฟรชสำเนาจาก Identity', async () => {
    const student = randomUUID();
    identity.setStudent(student, { major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });
    expect(await profiles.get(student)).to.deep.equal({ skills: [], major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });

    identity.setStudent(student, { major: 'วิทยาการข้อมูล', year_level: 4 });
    const updated = await profiles.update(student, { headline: 'Intern', skills: ['TypeScript', 'SQL'], portfolio_url: 'https://a.test' });
    expect(updated).to.deep.equal({ headline: 'Intern', skills: ['TypeScript', 'SQL'], portfolio_url: 'https://a.test', major: 'วิทยาการข้อมูล', year_level: 4 });

    identity.unavailable = true;
    const cleared = await profiles.update(student, {});
    expect(cleared).to.deep.equal({ skills: [], major: 'วิทยาการข้อมูล', year_level: 4 });
  });

  it('GET /me/profile ครั้งแรกพร้อมกันหลายคำขอ (React effect สองรอบ/เปิดสองแท็บ) ⇒ สำเร็จทุกคำขอ มีแถวเดียว', async () => {
    for (let round = 0; round < 5; round++) {
      const student = randomUUID();
      identity.setStudent(student, { major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });
      const results = await Promise.all(Array.from({ length: 5 }, () => profiles.get(student)));
      for (const result of results) {
        expect(result).to.deep.equal({ skills: [], major: 'วิศวกรรมคอมพิวเตอร์', year_level: 3 });
      }
      expect(await prisma.studentProfile.count({ where: { userId: student } })).to.equal(1);
    }
  });

  it('PUT ครั้งแรกพร้อม GET ครั้งแรก ⇒ ไม่ชน unique และค่าที่ PUT ถูกบันทึก', async () => {
    for (let round = 0; round < 5; round++) {
      const student = randomUUID();
      identity.setStudent(student, { major: 'บัญชี', year_level: 2 });
      const [, putResult] = await Promise.all([
        profiles.get(student),
        profiles.update(student, { headline: 'พร้อมกัน', skills: ['Excel'] }),
        profiles.get(student),
      ]);
      expect(putResult).to.deep.equal({ headline: 'พร้อมกัน', skills: ['Excel'], major: 'บัญชี', year_level: 2 });
      const row = await prisma.studentProfile.findUniqueOrThrow({ where: { userId: student } });
      expect(row.headline).to.equal('พร้อมกัน');
      expect(row.skills).to.deep.equal(['Excel']);
    }
  });

  it('PUT ครั้งแรกพร้อมกันสองคำขอ ⇒ สำเร็จทั้งคู่ มีแถวเดียว', async () => {
    for (let round = 0; round < 5; round++) {
      const student = randomUUID();
      identity.setStudent(student, { major: 'บัญชี', year_level: 2 });
      const results = await Promise.all([
        profiles.update(student, { headline: 'A' }),
        profiles.update(student, { headline: 'B' }),
      ]);
      expect(results.map((r) => r.headline).sort()).to.deep.equal(['A', 'B']);
      expect(await prisma.studentProfile.count({ where: { userId: student } })).to.equal(1);
    }
  });

  it('อัปโหลดพร้อมกัน 5 ไฟล์ ⇒ มีไฟล์หลักเพียง 1 ไฟล์ (advisory lock ต่อนักศึกษา)', async () => {
    const student = randomUUID();
    const results = await Promise.all(Array.from({ length: 5 }, () => resumes.upload(student, { buffer: SAMPLE_FILES.pdf() })));
    expect(results.filter((r) => r.is_primary)).to.have.length(1);
    expect(await prisma.resume.count({ where: { studentUserId: student, isPrimary: true } })).to.equal(1);
    expect(storage.objects.size).to.equal(5);
  });

  it('ลบไฟล์หลัก ⇒ ลบใน Storage, soft-delete และเลื่อนไฟล์ล่าสุดขึ้นเป็นไฟล์หลัก; รายการไม่แสดงไฟล์ที่ลบ', async () => {
    const student = randomUUID();
    const first = await resumes.upload(student, { buffer: SAMPLE_FILES.pdf() });
    const second = await resumes.upload(student, { buffer: SAMPLE_FILES.pdf() });
    const firstKey = (await prisma.resume.findUniqueOrThrow({ where: { id: first.id } })).objectKey;

    await resumes.remove(student, first.id);
    expect(storage.deleted).to.deep.equal([firstKey]);
    const removed = await prisma.resume.findUniqueOrThrow({ where: { id: first.id } });
    expect(removed.deletedAt).to.be.instanceOf(Date);

    const list = await resumes.list(student);
    expect(list.meta.total).to.equal(1);
    expect(list.data[0]).to.include({ id: second.id, is_primary: true });
  });

  it(`เพดาน ${MAX_ACTIVE_RESUMES} ไฟล์ใต้ล็อก: มี 4 ไฟล์แล้วอัปโหลดพร้อมกัน 3 ไฟล์ ⇒ ผ่าน 1 ไฟล์ ที่เหลือ 400 และลบไฟล์ชดเชย`, async () => {
    const student = randomUUID();
    for (let i = 0; i < MAX_ACTIVE_RESUMES - 1; i += 1) await resumes.upload(student, { buffer: SAMPLE_FILES.pdf() });
    const results = await Promise.allSettled(Array.from({ length: 3 }, () => resumes.upload(student, { buffer: SAMPLE_FILES.pdf() })));

    expect(results.filter((r) => r.status === 'fulfilled')).to.have.length(1);
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected).to.have.length(2);
    for (const r of rejected) {
      expect(r.reason).to.be.instanceOf(AppException);
      expect((r.reason as AppException).code).to.equal('VALIDATION_FAILED');
      expect((r.reason as AppException).details).to.deep.equal([{ field: 'file', issue: 'RESUME_LIMIT_REACHED' }]);
    }
    expect(await prisma.resume.count({ where: { studentUserId: student, deletedAt: null } })).to.equal(MAX_ACTIVE_RESUMES);
    expect(storage.objects.size).to.equal(MAX_ACTIVE_RESUMES);
  });

  it('ลบไฟล์หลักพร้อมอัปโหลดไฟล์ใหม่ (ล็อกเดียวกัน) ⇒ เหลือไฟล์หลักพอดี 1 ไฟล์ทุกรอบ', async () => {
    for (let round = 0; round < 5; round += 1) {
      const student = randomUUID();
      const primary = await resumes.upload(student, { buffer: SAMPLE_FILES.pdf() });
      await Promise.all([resumes.remove(student, primary.id), resumes.upload(student, { buffer: SAMPLE_FILES.pdf() })]);
      expect(await prisma.resume.count({ where: { studentUserId: student, deletedAt: null } }), `round ${round}`).to.equal(1);
      expect(await prisma.resume.count({ where: { studentUserId: student, deletedAt: null, isPrimary: true } }), `round ${round}`).to.equal(1);
    }
  });

  it('นักศึกษาลบเรซูเม่ของใบสมัครแล้ว ⇒ forHr/forAdvisor โยน 404 + RESUME_DELETED_BY_STUDENT', async () => {
    const student = randomUUID();
    const company = randomUUID();
    const advisor = randomUUID();
    const uploaded = await resumes.upload(student, { buffer: SAMPLE_FILES.pdf() });
    const application = await prisma.application.create({
      data: { jobId: randomUUID(), companyId: company, studentUserId: student, advisorUserId: advisor, resumeId: uploaded.id },
    });
    identity.consents.add(`${student}:${company}`);
    await resumes.remove(student, uploaded.id);

    const calls = [
      () => resumes.forHr({ role: 'COMPANY_HR', sub: randomUUID(), company_id: company } as never, application.id),
      () => resumes.forAdvisor({ role: 'ADVISOR', sub: advisor } as never, application.id),
    ];
    for (const call of calls) {
      const error = await call().then(() => null, (e: unknown) => e);
      expect(error).to.be.instanceOf(AppException);
      expect((error as AppException).getStatus()).to.equal(404);
      expect((error as AppException).details).to.deep.equal([{ field: 'resume', issue: 'RESUME_DELETED_BY_STUDENT' }]);
    }
  });

  it('HR/อาจารย์อ่านเรซูเม่ของใบสมัครจากแถวจริง (select + ownership + consent)', async () => {
    const student = randomUUID();
    const company = randomUUID();
    const advisor = randomUUID();
    const uploaded = await resumes.upload(student, { buffer: SAMPLE_FILES.pdf() });
    const application = await prisma.application.create({
      data: { jobId: randomUUID(), companyId: company, studentUserId: student, advisorUserId: advisor, resumeId: uploaded.id },
    });
    identity.consents.add(`${student}:${company}`);

    const hr = await resumes.forHr({ role: 'COMPANY_HR', sub: randomUUID(), company_id: company } as never, application.id);
    expect(hr.url).to.be.a('string');
    const adv = await resumes.forAdvisor({ role: 'ADVISOR', sub: advisor } as never, application.id);
    expect(adv.url).to.be.a('string');
  });
});
