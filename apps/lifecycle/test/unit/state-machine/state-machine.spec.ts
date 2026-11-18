import { AppException, OutboxWriter } from '@internpath/common';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import sinon from 'sinon';
import { LIFECYCLE_DEFAULTS, type LifecycleConfigKey } from '../../../src/config/lifecycle.constants';
import { ApplicationStateMachine } from '../../../src/state-machine/application-state-machine.service';
import { ApplicationTransitionService } from '../../../src/state-machine/application-transition.service';
import { toDateOnly } from '../../../src/state-machine/dates';
import { QuotaService, collectQuotaEffects } from '../../../src/state-machine/quota.service';
import { ReapplyPolicy } from '../../../src/state-machine/reapply-policy';
import { StatusHistoryWriter } from '../../../src/state-machine/status-history.writer';
import { createFakePrisma, makeApplication, type FakePrisma } from '../../support/fake-prisma';

const NOW = new Date('2026-07-01T03:00:00Z');

function jobClientStub() {
  return {
    reserveQuota: sinon.stub().resolves({ reserved: true }),
    confirmQuota: sinon.stub().resolves(),
    releaseQuota: sinon.stub().resolves(),
  };
}

async function rejects(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).to.equal(code);
    return;
  }
  expect.fail(`expected ${code}`);
}

describe('State Machine — ApplicationStateMachine (โควตา + Transaction)', () => {
  let db: FakePrisma;
  let job: ReturnType<typeof jobClientStub>;
  let machine: ApplicationStateMachine;
  const hr = { userId: randomUUID(), role: 'COMPANY_HR' as const };
  const acceptInput = { startDate: toDateOnly('2026-07-15'), endDate: toDateOnly('2026-09-15') };

  beforeEach(() => {
    db = createFakePrisma();
    job = jobClientStub();
    const config = { getNumber: async (key: LifecycleConfigKey) => LIFECYCLE_DEFAULTS[key] };
    machine = new ApplicationStateMachine(
      db as any,
      new ApplicationTransitionService(new OutboxWriter(), new StatusHistoryWriter()),
      new QuotaService(job as any),
      config as any,
    );
  });

  afterEach(() => sinon.restore());

  it('HR ตอบรับ: reserve โควตาด้วย application_id ก่อน แล้วเปลี่ยนสถานะใน Transaction', async () => {
    const app = makeApplication({ status: 'PENDING' });
    db.state.tables.application.push(app);
    const result = await machine.execute(app.id, { trigger: 'accept', actor: hr, input: acceptInput, correlationId: 'c-1' }, NOW);
    expect(job.reserveQuota.calledOnceWith(app.jobId, app.id, 'c-1')).to.equal(true);
    expect(result.application.status).to.equal('HR_ACCEPTED');
    expect(db.transactions).to.equal(1);
  });

  it('Guard ไม่ผ่าน (ช่วงฝึก < 30 วัน) ⇒ ไม่เรียก reserve เลย', async () => {
    const app = makeApplication({ status: 'PENDING' });
    db.state.tables.application.push(app);
    await rejects(
      machine.execute(
        app.id,
        { trigger: 'accept', actor: hr, input: { startDate: toDateOnly('2026-07-15'), endDate: toDateOnly('2026-08-01') }, correlationId: 'c' },
        NOW,
      ),
      'INVALID_PERIOD_MIN_30_DAYS',
    );
    expect(job.reserveQuota.called).to.equal(false);
  });

  it('โควตาเต็ม ⇒ 409 QUOTA_FULL จาก Job ส่งต่อ และสถานะไม่เปลี่ยน', async () => {
    const app = makeApplication({ status: 'PENDING' });
    db.state.tables.application.push(app);
    job.reserveQuota.rejects(new AppException('QUOTA_FULL', 'full', 409));
    await rejects(machine.execute(app.id, { trigger: 'accept', actor: hr, input: acceptInput, correlationId: 'c' }, NOW), 'QUOTA_FULL');
    expect(db.state.tables.application[0].status).to.equal('PENDING');
    expect(db.transactions).to.equal(0);
  });

  it('reserve สำเร็จแต่ Transaction ล้ม (มีคนเปลี่ยนสถานะไปก่อน) ⇒ release ชดเชย + rollback', async () => {
    const app = makeApplication({ status: 'PENDING' });
    db.state.tables.application.push(app);
    job.reserveQuota.callsFake(async () => {
      // ระหว่างรอ Job นักศึกษาถอนใบสมัครไปแล้ว
      db.state.tables.application[0].status = 'WITHDRAWN';
      return { reserved: true };
    });
    await rejects(machine.execute(app.id, { trigger: 'accept', actor: hr, input: acceptInput, correlationId: 'c' }, NOW), 'STATE_CONFLICT');
    expect(job.releaseQuota.calledOnceWith(app.jobId, app.id, 'TRANSITION_FAILED')).to.equal(true);
    expect(db.state.tables.outboxEvent).to.deep.equal([]);
  });

  it('HR กดตอบรับซ้ำพร้อมกัน: ผู้แพ้ได้ STATE_CONFLICT แต่ต้องไม่ release โควตาที่ผู้ชนะถืออยู่ (รีวิว PR #36)', async () => {
    const app = makeApplication({ status: 'PENDING' });
    db.state.tables.application.push(app);
    job.reserveQuota.callsFake(async () => {
      // อีกคำสั่ง accept ของใบเดียวกัน reserve (idempotent ด้วย application_id) และ commit ก่อนเรา
      Object.assign(db.state.tables.application[0], { status: 'HR_ACCEPTED', quotaReserved: true });
      return { reserved: true };
    });
    await rejects(machine.execute(app.id, { trigger: 'accept', actor: hr, input: acceptInput, correlationId: 'c' }, NOW), 'STATE_CONFLICT');
    expect(job.reserveQuota.calledOnce).to.equal(true);
    expect(job.releaseQuota.called).to.equal(false);
    expect(db.state.tables.application[0]).to.include({ status: 'HR_ACCEPTED', quotaReserved: true });
  });

  it('อ่านสถานะโควตาก่อนชดเชยไม่สำเร็จ ⇒ ไม่ release (ปล่อยให้ Reconciliation แก้แทนการรับเกินโควตา)', async () => {
    const app = makeApplication({ status: 'PENDING' });
    db.state.tables.application.push(app);
    const realFindUnique = db.application.findUnique;
    let calls = 0;
    db.application.findUnique = async (args: any) => {
      calls++;
      // ครั้งที่ 1 = execute อ่านใบสมัคร, ครั้งที่ 2 = ใน Transaction, ครั้งที่ 3 = ตรวจก่อนชดเชย
      if (calls === 3) throw new Error('db down');
      return realFindUnique(args);
    };
    job.reserveQuota.callsFake(async () => {
      db.state.tables.application[0].status = 'WITHDRAWN';
      return { reserved: true };
    });
    await rejects(machine.execute(app.id, { trigger: 'accept', actor: hr, input: acceptInput, correlationId: 'c' }, NOW), 'STATE_CONFLICT');
    expect(calls).to.equal(3);
    expect(job.releaseQuota.called).to.equal(false);
  });

  it('confirm-offer: release โควตาของใบที่ถูกปฏิเสธแทนหลัง commit', async () => {
    const studentUserId = randomUUID();
    const chosen = makeApplication({ status: 'HR_ACCEPTED', studentUserId });
    const other = makeApplication({ status: 'HR_ACCEPTED', studentUserId });
    db.state.tables.application.push(chosen, other);
    const result = await machine.execute(
      chosen.id,
      { trigger: 'confirm-offer', actor: { userId: studentUserId, role: 'STUDENT' }, correlationId: 'c' },
      NOW,
    );
    expect(job.releaseQuota.calledOnceWith(other.jobId, other.id, 'STUDENT_DECLINED')).to.equal(true);
    expect(result.quotaFailures).to.deep.equal([]);
  });

  it('HR ยืนยันเริ่มงาน ⇒ confirm โควตาหลัง commit; Job ล่มก็ยังสำเร็จ (รอ Reconciliation)', async () => {
    const app = makeApplication({ status: 'ADVISOR_APPROVED', endDate: toDateOnly('2026-09-30') });
    db.state.tables.application.push(app);
    job.confirmQuota.rejects(new AppException('UPSTREAM_UNAVAILABLE', 'down', 502));
    const result = await machine.execute(
      app.id,
      { trigger: 'start', actor: hr, patch: { actualStartDate: toDateOnly('2026-07-01') }, correlationId: 'c' },
      NOW,
    );
    expect(result.application.status).to.equal('IN_PROGRESS');
    expect(result.quotaFailures).to.deep.equal([
      { effect: 'CONFIRM', jobId: app.jobId, applicationId: app.id, reason: 'IN_PROGRESS' },
    ]);
  });

  it('ไม่พบใบสมัคร ⇒ 404 NOT_FOUND', async () => {
    await rejects(machine.execute(randomUUID(), { trigger: 'withdraw', actor: hr, correlationId: 'c' }, NOW), 'NOT_FOUND');
  });

  it('availableActions อ่านข้อมูลที่ต้องใช้เองจาก DB', async () => {
    const studentUserId = randomUUID();
    const app = makeApplication({ status: 'PENDING', studentUserId });
    db.state.tables.application.push(app, makeApplication({ status: 'IN_PROGRESS', studentUserId }));
    const result = await machine.availableActions(app, 'COMPANY_HR', NOW);
    expect(result).to.deep.equal({ available_actions: ['reject'], accept_blocked_reason: 'ALREADY_CONFIRMED_ELSEWHERE' });
  });

  it('collectQuotaEffects รวมผลของ Cascade ทุกชั้น', () => {
    const effect = (id: string) => ({ effect: 'RELEASE' as const, jobId: 'j', applicationId: id, reason: 'X' });
    expect(
      collectQuotaEffects({ quota: [effect('a')], cascaded: [{ quota: [effect('b')], cascaded: [] } as any] }).map((e) => e.applicationId),
    ).to.deep.equal(['a', 'b']);
  });
});

describe('State Machine — ห้ามสมัครซ้ำหลัง ACADEMIC_PASS (reapply_unlocks)', () => {
  let db: FakePrisma;
  const policy = new ReapplyPolicy();
  const studentUserId = randomUUID();
  const passAt = new Date('2026-05-01T00:00:00Z');

  beforeEach(() => {
    db = createFakePrisma();
  });

  it('ไม่เคย ACADEMIC_PASS ⇒ สมัครได้', async () => {
    db.state.tables.application.push(makeApplication({ studentUserId, status: 'COMPLETED', academicResult: 'ACADEMIC_FAIL' }));
    expect(await policy.check(db as any, studentUserId)).to.deep.equal({ blocked: false });
  });

  it('ACADEMIC_PASS แล้ว ⇒ 403 REAPPLY_BLOCKED', async () => {
    db.state.tables.application.push(
      makeApplication({ studentUserId, status: 'COMPLETED', academicResult: 'ACADEMIC_PASS', academicRecordedAt: passAt }),
    );
    expect(await policy.check(db as any, studentUserId)).to.deep.equal({ blocked: true });
    await rejects(policy.assertAndConsume(db as any, studentUserId, NOW), 'REAPPLY_BLOCKED');
  });

  it('Admin ปลดล็อกหลังผลผ่าน ⇒ สมัครได้ 1 ครั้ง และตั้ง used_at', async () => {
    db.state.tables.application.push(
      makeApplication({ studentUserId, status: 'COMPLETED', academicResult: 'ACADEMIC_PASS', academicRecordedAt: passAt }),
    );
    // สิทธิ์เก่าที่สร้างก่อนผลผ่านล่าสุดใช้ไม่ได้
    db.state.tables.reapplyUnlock.push(
      { id: randomUUID(), studentUserId, createdAt: new Date('2026-04-01T00:00:00Z'), usedAt: null },
      { id: 'unlock-1', studentUserId, createdAt: new Date('2026-06-01T00:00:00Z'), usedAt: null },
    );
    expect(await policy.assertAndConsume(db as any, studentUserId, NOW)).to.deep.equal({ blocked: false, unlockId: 'unlock-1' });
    expect(db.state.tables.reapplyUnlock[1].usedAt.getTime()).to.equal(NOW.getTime());
    await rejects(policy.assertAndConsume(db as any, studentUserId, NOW), 'REAPPLY_BLOCKED');
  });

  it('ผลผ่านจาก TERMINATED (บันทึกผลโดยไม่เปลี่ยนสถานะ) ก็บล็อกเช่นกัน', async () => {
    db.state.tables.application.push(
      makeApplication({ studentUserId, status: 'TERMINATED', academicResult: 'ACADEMIC_PASS', academicRecordedAt: passAt }),
    );
    expect((await policy.check(db as any, studentUserId)).blocked).to.equal(true);
  });
});
