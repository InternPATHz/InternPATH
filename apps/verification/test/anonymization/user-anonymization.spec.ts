import { randomUUID } from 'node:crypto';
import type { UserDeletionRequestedPayload } from '@internpath/contracts';
import { expect } from 'chai';
import { AnonymizationModule } from '../../src/anonymization/anonymization.module';
import { UserAnonymizationService } from '../../src/anonymization/user-anonymization.service';
import { createTestApp, type TestApp } from '../support/app';
import { createTestDatabase, dbReachableOrSkip, type TestDatabase } from '../support/db';
import { envelope } from '../support/events';

describe('UserAnonymizationService — E15 UserDeletionRequested (Postgres จริง)', function () {
  this.timeout(60000);
  let db: TestDatabase;
  let t: TestApp;
  let svc: UserAnonymizationService;

  before(async function () {
    await dbReachableOrSkip(this);
    db = await createTestDatabase();
    t = await createTestApp({ imports: [AnonymizationModule], db });
    svc = t.app.get(UserAnonymizationService);
  });
  after(async () => {
    await t?.app.close();
    await db?.drop();
  });

  const payload = (userId: string, anonymous: string = randomUUID(), role = 'STUDENT'): UserDeletionRequestedPayload => ({
    user_id: userId,
    role,
    requested_at: new Date().toISOString(),
    mode: 'DELETE_AND_ANONYMIZE',
    anonymous_actor_id: anonymous,
  });
  const apply = (p: UserDeletionRequestedPayload) =>
    t.prisma.$transaction((tx) => svc.handleUserDeletionRequested(envelope('UserDeletionRequested', p, 'identity'), tx));

  const history = (actorId: string | null, entityId = randomUUID()) =>
    t.prisma.$executeRaw`INSERT INTO status_history (entity, entity_id, to_status, actor_id, actor_role, correlation_id)
      VALUES ('QUEUE_ITEM', ${entityId}::uuid, 'OPEN', ${actorId}::uuid, 'PLATFORM_ADMIN', ${randomUUID()}::uuid)`;
  const audit = (adminId: string) =>
    t.prisma.$executeRaw`INSERT INTO admin_audit_log (admin_id, action, target_type, target_id, reason, correlation_id)
      VALUES (${adminId}::uuid, 'TEST', 'x', ${randomUUID()}, 'เหตุผลเดิม', ${randomUUID()}::uuid)`;
  const queueItem = (over: { status: 'OPEN' | 'IN_REVIEW' | 'RESOLVED'; assignedTo: string }) =>
    t.prisma.queueItem.create({
      data: { type: 'JOB_REVIEW', targetType: 'JOB', targetId: randomUUID(), origin: 'ADMIN_FLAG', dueAt: new Date(), ...over },
    });

  it('แทน actor_id/admin_id ใน status_history และ admin_audit_log เฉพาะของผู้ใช้นี้ โดยไม่แตะคอลัมน์อื่นและไม่แตะของคนอื่น', async () => {
    const user = randomUUID();
    const other = randomUUID();
    const anonymous = randomUUID();
    await history(user);
    await history(user);
    await history(other);
    await history(null);
    await audit(user);
    await audit(other);

    await apply(payload(user, anonymous, 'PLATFORM_ADMIN'));

    expect(await t.prisma.statusHistory.count({ where: { actorId: user } })).to.equal(0);
    expect(await t.prisma.statusHistory.count({ where: { actorId: anonymous } })).to.equal(2);
    expect(await t.prisma.statusHistory.count({ where: { actorId: other } })).to.equal(1);
    expect(await t.prisma.statusHistory.count({ where: { actorId: null, actorRole: 'PLATFORM_ADMIN' } })).to.equal(1);
    const anonAudit = await t.prisma.adminAuditLog.findMany({ where: { adminId: anonymous } });
    expect(anonAudit).to.have.length(1);
    expect(anonAudit[0]).to.include({ action: 'TEST', reason: 'เหตุผลเดิม' });
    expect(await t.prisma.adminAuditLog.count({ where: { adminId: other } })).to.equal(1);
  });

  it('รายงานประกาศ: เก็บแถว/สถานะ/ผลต่อตัวนับ แต่เปลี่ยนผู้รายงานเป็นรหัสนิรนามและล้าง detail ทุกสถานะ; ลบ reporter_stats; ไม่แตะของคนอื่น', async () => {
    const user = randomUUID();
    const other = randomUUID();
    const anonymous = randomUUID();
    const jobs = [randomUUID(), randomUUID(), randomUUID()];
    const statuses = ['OPEN', 'DISMISSED', 'UPHELD'] as const;
    for (const [i, jobId] of jobs.entries()) {
      await t.prisma.jobReport.create({
        data: { jobId, reporterUserId: user, category: 'SCAM', detail: 'โทร 081-234-5678', counted: i !== 1, status: statuses[i] },
      });
    }
    const othersJob = randomUUID();
    await t.prisma.jobReport.create({ data: { jobId: othersJob, reporterUserId: other, category: 'SCAM', detail: 'ของคนอื่น', counted: true } });
    await t.prisma.reporterStat.create({ data: { userId: user, consecutiveDismissed: 2 } });
    await t.prisma.reporterStat.create({ data: { userId: other, consecutiveDismissed: 1 } });

    await apply(payload(user, anonymous));

    const reports = await t.prisma.jobReport.findMany({ where: { reporterUserId: anonymous }, orderBy: { createdAt: 'asc' } });
    expect(reports).to.have.length(3);
    expect(reports.map((r) => r.status).sort()).to.deep.equal(['DISMISSED', 'OPEN', 'UPHELD']);
    expect(reports.map((r) => r.counted).sort()).to.deep.equal([false, true, true]);
    for (const r of reports) expect(r).to.include({ detail: '', category: 'SCAM' });
    expect(await t.prisma.jobReport.count({ where: { reporterUserId: user } })).to.equal(0);
    expect(await t.prisma.jobReport.findFirst({ where: { jobId: othersJob } })).to.include({ reporterUserId: other, detail: 'ของคนอื่น' });
    expect(await t.prisma.reporterStat.findUnique({ where: { userId: user } })).to.equal(null);
    expect(await t.prisma.reporterStat.findUnique({ where: { userId: other } })).to.not.equal(null);
  });

  it('id ของ Admin ในตารางอื่น: decided_by / created_by / updated_by / cleared_by → รหัสนิรนาม; คิวที่ยังไม่ปิดถูกปลดผู้รับผิดชอบ, คิวที่ปิดแล้วเก็บเป็นรหัสนิรนาม', async () => {
    const admin = randomUUID();
    const anonymous = randomUUID();
    const appeal = await t.prisma.appeal.create({
      data: { jobId: randomUUID(), submissionId: randomUUID(), statement: 'ข้อความอุทธรณ์ของบริษัท', status: 'DENIED', decidedBy: admin, decidedAt: new Date() },
    });
    const term = await t.prisma.blacklistTerm.create({ data: { term: `คำ-${randomUUID()}`, severity: 'SOFT', createdBy: admin } });
    await t.prisma.riskRule.update({ where: { code: 'CONTACT_IN_TEXT' }, data: { updatedBy: admin } });
    const companyId = randomUUID();
    await t.prisma.companyFlag.create({ data: { companyId, underReview: false, clearedBy: admin, setBy: 'ADMIN' } });
    const open = await queueItem({ status: 'OPEN', assignedTo: admin });
    const inReview = await queueItem({ status: 'IN_REVIEW', assignedTo: admin });
    const resolved = await queueItem({ status: 'RESOLVED', assignedTo: admin });

    await apply(payload(admin, anonymous, 'PLATFORM_ADMIN'));

    expect((await t.prisma.appeal.findUnique({ where: { id: appeal.id } }))!).to.include({ decidedBy: anonymous, statement: 'ข้อความอุทธรณ์ของบริษัท' });
    expect((await t.prisma.blacklistTerm.findUnique({ where: { id: term.id } }))!.createdBy).to.equal(anonymous);
    expect((await t.prisma.riskRule.findUnique({ where: { code: 'CONTACT_IN_TEXT' } }))!.updatedBy).to.equal(anonymous);
    expect((await t.prisma.companyFlag.findUnique({ where: { companyId } }))!.clearedBy).to.equal(anonymous);
    expect((await t.prisma.queueItem.findUnique({ where: { id: open.id } }))!.assignedTo).to.equal(null);
    expect((await t.prisma.queueItem.findUnique({ where: { id: inReview.id } }))!.assignedTo).to.equal(null);
    expect((await t.prisma.queueItem.findUnique({ where: { id: resolved.id } }))!.assignedTo).to.equal(anonymous);
  });

  it('ประมวลผลซ้ำ (Event ถูกส่งซ้ำ) ได้ผลเท่าเดิมและไม่ error; ผู้ใช้ที่ไม่มีข้อมูลในระบบก็ไม่ error', async () => {
    const user = randomUUID();
    const anonymous = randomUUID();
    await history(user);
    await t.prisma.jobReport.create({ data: { jobId: randomUUID(), reporterUserId: user, category: 'X', detail: 'รายละเอียด', counted: true } });
    await apply(payload(user, anonymous));
    await apply(payload(user, anonymous));
    expect(await t.prisma.statusHistory.count({ where: { actorId: anonymous } })).to.equal(1);
    expect(await t.prisma.jobReport.count({ where: { reporterUserId: anonymous, detail: '' } })).to.equal(1);
    await apply(payload(randomUUID()));
  });

  it('รายงานของผู้ใช้สองคนที่ถูกลบในประกาศเดียวกัน ไม่ชน UNIQUE (job_id, reporter_user_id) เพราะรหัสนิรนามแยกต่อคน', async () => {
    const jobId = randomUUID();
    const a = randomUUID();
    const b = randomUUID();
    for (const reporterUserId of [a, b]) {
      await t.prisma.jobReport.create({ data: { jobId, reporterUserId, category: 'X', detail: 'd', counted: true } });
    }
    await apply(payload(a));
    await apply(payload(b));
    expect(await t.prisma.jobReport.count({ where: { jobId, detail: '' } })).to.equal(2);
  });

  it('payload ไม่ถูกต้อง (anonymous_actor_id ไม่ใช่ UUID, user_id ว่าง) → ปฏิเสธและไม่แก้ข้อมูลใดๆ', async () => {
    const user = randomUUID();
    await history(user);
    for (const bad of [payload(user, 'ไม่ใช่-uuid'), payload('', randomUUID()), payload(user, user)]) {
      let message = '';
      try {
        await apply(bad);
      } catch (e) {
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(bad)).to.match(/UserDeletionRequested/);
    }
    expect(await t.prisma.statusHistory.count({ where: { actorId: user } })).to.equal(1);
  });

  it('setting สำหรับ trigger มีผลเฉพาะ Transaction ของ handler: หลังเสร็จ UPDATE history ธรรมดายังถูกปฏิเสธ', async () => {
    const user = randomUUID();
    await history(user);
    await apply(payload(user));
    let message = '';
    try {
      await t.prisma.$executeRaw`UPDATE status_history SET to_status = 'X'`;
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).to.match(/append-only/i);
  });
});
