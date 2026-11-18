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
import { ResumesService } from '../../src/modules/resumes/resumes.service';
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
    profiles = new ProfilesService(db, identity as unknown as IdentityInternalClient);
    resumes = new ResumesService(db, storage as unknown as S3StorageService, config, identity as unknown as IdentityInternalClient);
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
