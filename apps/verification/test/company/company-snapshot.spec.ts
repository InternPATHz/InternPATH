import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { CompanyModule } from '../../src/company/company.module';
import { CompanySnapshotService } from '../../src/company/company-snapshot.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { companyChanged, envelope } from '../support/events';

describe('CompanySnapshotService (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: CompanySnapshotService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [CompanyModule], db });
    svc = t.app.get(CompanySnapshotService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const apply = (p: ReturnType<typeof companyChanged>) =>
    t.prisma.$transaction((tx) => svc.handleCompanyStatusChanged(envelope('CompanyStatusChanged', p, 'identity'), tx));
  const row = (id: string) => t.prisma.companySnapshot.findUnique({ where: { companyId: id } });

  it('E05 ใหม่ → สร้างแถว; version สูงกว่า → อัปเดต; version เก่ากว่าหรือเท่ากัน → ไม่เขียนทับ', async () => {
    const id = randomUUID();
    await apply(companyChanged({ company_id: id, entity_version: 2, status: 'VERIFIED', snapshot: { name: 'ชื่อ v2', university_partner: false, verified_badge: true } }));
    expect(await row(id)).to.include({ name: 'ชื่อ v2', status: 'VERIFIED', entityVersion: 2 });

    await apply(companyChanged({ company_id: id, entity_version: 1, status: 'PENDING', snapshot: { name: 'ชื่อ v1 (เก่า)', university_partner: false, verified_badge: false } }));
    expect(await row(id)).to.include({ name: 'ชื่อ v2', status: 'VERIFIED', entityVersion: 2 });

    await apply(companyChanged({ company_id: id, entity_version: 2, status: 'SUSPENDED', snapshot: { name: 'ชื่อซ้ำ version เท่ากัน', university_partner: false, verified_badge: false } }));
    expect(await row(id)).to.include({ name: 'ชื่อ v2', status: 'VERIFIED', entityVersion: 2 });

    await apply(companyChanged({ company_id: id, entity_version: 3, status: 'SUSPENDED', snapshot: { name: 'ชื่อ v3', university_partner: false, verified_badge: false } }));
    expect(await row(id)).to.include({ name: 'ชื่อ v3', status: 'SUSPENDED', entityVersion: 3 });
  });

  it('ประมวลผลพร้อมกัน (v1 กับ v2) ผลสุดท้ายต้องเป็น v2 เสมอ', async () => {
    const id = randomUUID();
    await Promise.all([
      apply(companyChanged({ company_id: id, entity_version: 1, snapshot: { name: 'v1', university_partner: false, verified_badge: false } })),
      apply(companyChanged({ company_id: id, entity_version: 2, snapshot: { name: 'v2', university_partner: false, verified_badge: false } })),
    ]);
    expect(await row(id)).to.include({ name: 'v2', entityVersion: 2 });
  });
});
