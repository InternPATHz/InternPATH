import { OutboxWriter } from '@internpath/common';
import type { ApplicationStatusChangedPayload } from '@internpath/contracts';
import { expect } from 'chai';
import { randomUUID } from 'node:crypto';
import type { Application } from '../../../generated/client';
import {
  ApplicationTransitionService,
  type TransitionCommand,
} from '../../../src/state-machine/application-transition.service';
import { toDateOnly } from '../../../src/state-machine/dates';
import { StatusHistoryWriter, SYSTEM_ACTOR } from '../../../src/state-machine/status-history.writer';
import { createFakePrisma, makeApplication, type FakePrisma } from '../../support/fake-prisma';

const CONFIG = { minActualDays: 30, disputeWindowDays: 7, noEvaluationAfterDays: 14 };
const NOW = new Date('2026-07-01T03:00:00Z');
const CORRELATION = randomUUID();

async function expectAppError(promise: Promise<unknown>, code: string, status?: number): Promise<any> {
  try {
    await promise;
  } catch (error) {
    expect((error as { code?: string }).code).to.equal(code);
    if (status) expect((error as { getStatus(): number }).getStatus()).to.equal(status);
    return error;
  }
  expect.fail(`expected ${code}`);
}

describe('State Machine — ApplicationTransitionService (Transaction เดียว)', () => {
  let db: FakePrisma;
  let service: ApplicationTransitionService;

  const seed = (overrides: Partial<Application>) => {
    const app = makeApplication(overrides);
    db.state.tables.application.push(app);
    return app;
  };
  const apply = (app: Application, command: Omit<TransitionCommand, 'correlationId'>, now = NOW) =>
    service.apply(db as any, app, { correlationId: CORRELATION, ...command }, now, CONFIG);
  const hr = { userId: randomUUID(), role: 'COMPANY_HR' as const };
  const payloads = () => db.state.tables.outboxEvent.map((e) => e.payload as ApplicationStatusChangedPayload);

  beforeEach(() => {
    db = createFakePrisma();
    service = new ApplicationTransitionService(new OutboxWriter(), new StatusHistoryWriter());
  });

  it('เปลี่ยนสถานะ + status_history + outbox(E08) พร้อมกัน, รีเซ็ตฐานนับ SLA และเพิ่ม version', async () => {
    const app = seed({ status: 'PENDING', slaPausedSeconds: 3600, statusChangedAt: new Date('2026-06-20T00:00:00Z') });
    const outcome = await apply(app, {
      trigger: 'accept',
      actor: hr,
      input: { startDate: toDateOnly('2026-07-15'), endDate: toDateOnly('2026-09-15') },
    });

    const row = db.state.tables.application[0];
    expect(row.status).to.equal('HR_ACCEPTED');
    expect(row.slaPausedSeconds).to.equal(0);
    expect(row.statusChangedAt.getTime()).to.equal(NOW.getTime());
    expect(row.version).to.equal(2);
    expect(row.entityVersion).to.equal(2);
    expect(row.quotaReserved).to.equal(true);
    expect(row.startDate.toISOString()).to.equal('2026-07-15T00:00:00.000Z');

    expect(db.state.tables.statusHistory).to.have.length(1);
    expect(db.state.tables.statusHistory[0]).to.include({
      entity: 'APPLICATION',
      entityId: app.id,
      fromStatus: 'PENDING',
      toStatus: 'HR_ACCEPTED',
      actorId: hr.userId,
      actorRole: 'COMPANY_HR',
      correlationId: CORRELATION,
    });

    expect(db.state.tables.outboxEvent).to.have.length(1);
    const event = db.state.tables.outboxEvent[0];
    expect(event).to.include({ type: 'ApplicationStatusChanged', aggregateId: app.id, correlationId: CORRELATION });
    expect(event.id).to.equal(outcome.eventId);
    expect(event.payload).to.deep.equal({
      application_id: app.id,
      job_id: app.jobId,
      company_id: app.companyId,
      student_user_id: app.studentUserId,
      advisor_user_id: app.advisorUserId,
      from_status: 'PENDING',
      to_status: 'HR_ACCEPTED',
      actor_user_id: hr.userId,
      actor_role: 'COMPANY_HR',
      entity_version: 2,
      changed_at: NOW.toISOString(),
    });
    // reserve ทำนอก Transaction (orchestrator) — ใน Transaction ไม่มีงานโควตาค้าง
    expect(outcome.quota).to.deep.equal([]);
  });

  it('E08 ไม่มีข้อมูลส่วนบุคคล — มีแค่คีย์ตาม event-contract', async () => {
    const app = seed({ status: 'IN_PROGRESS', coverLetter: 'สวัสดีครับ ผมชื่อ ...' });
    await apply(app, { trigger: 'request-termination', actor: { userId: app.studentUserId, role: 'STUDENT' }, reason: 'ย้ายที่ฝึก' });
    const allowed = [
      'application_id',
      'job_id',
      'company_id',
      'student_user_id',
      'advisor_user_id',
      'hr_user_ids',
      'from_status',
      'to_status',
      'actor_user_id',
      'actor_role',
      'reason',
      'terminated_by',
      'entity_version',
      'changed_at',
    ];
    expect(Object.keys(payloads()[0])).to.satisfy((keys: string[]) => keys.every((k) => allowed.includes(k)));
    expect(payloads()[0]).to.include({ to_status: 'TERMINATED', terminated_by: 'STUDENT', reason: 'ย้ายที่ฝึก' });
  });

  it('SYSTEM ⇒ ไม่มี actor_user_id และ status_history.actor_id = null', async () => {
    const app = seed({ status: 'PENDING' });
    await apply(app, { trigger: 'expire', actor: SYSTEM_ACTOR });
    expect(payloads()[0]).to.not.have.property('actor_user_id');
    expect(payloads()[0].actor_role).to.equal('SYSTEM');
    expect(db.state.tables.statusHistory[0].actorId).to.equal(null);
  });

  it('คู่ที่ไม่อยู่ในตาราง ⇒ 409 STATE_CONFLICT และไม่เขียนอะไรเลย', async () => {
    const app = seed({ status: 'PENDING' });
    await expectAppError(apply(app, { trigger: 'start', actor: hr }), 'STATE_CONFLICT', 409);
    // ผู้กระทำผิด role
    await expectAppError(apply(app, { trigger: 'withdraw', actor: hr }), 'STATE_CONFLICT', 409);
    expect(db.state.tables.application[0].status).to.equal('PENDING');
    expect(db.state.tables.statusHistory).to.deep.equal([]);
    expect(db.state.tables.outboxEvent).to.deep.equal([]);
  });

  it('สองคำสั่งจากสถานะเดียวกัน: ผู้ชนะ 1 ราย อีกฝ่าย 409 STATE_CONFLICT (updateMany where status = เดิม)', async () => {
    const app = seed({ status: 'PENDING' });
    await apply(app, { trigger: 'withdraw', actor: { userId: app.studentUserId, role: 'STUDENT' } });
    // HR ยังถือข้อมูลชุดเดิม (status = PENDING) อยู่
    const error = await expectAppError(apply(app, { trigger: 'reject', actor: hr }), 'STATE_CONFLICT', 409);
    expect(error.details[0].issue).to.equal('STALE_STATUS');
    expect(db.state.tables.application[0].status).to.equal('WITHDRAWN');
    expect(db.state.tables.outboxEvent).to.have.length(1);
  });

  it('ต้องมีเหตุผล: ถอนข้อเสนอโดยไม่มีเหตุผล ⇒ 400 REASON_REQUIRED; มีเหตุผล ⇒ บันทึกลง rescind_reason + release', async () => {
    const app = seed({ status: 'ADVISOR_APPROVED', quotaReserved: true });
    await expectAppError(apply(app, { trigger: 'rescind-offer', actor: hr, reason: ' ' }), 'REASON_REQUIRED', 400);
    const outcome = await apply(app, { trigger: 'rescind-offer', actor: hr, reason: 'ตำแหน่งถูกยุบ' });
    const row = db.state.tables.application[0];
    expect(row).to.include({ status: 'OFFER_RESCINDED', rescindReason: 'ตำแหน่งถูกยุบ', quotaReserved: false });
    expect(outcome.quota).to.deep.equal([
      { effect: 'RELEASE', jobId: app.jobId, applicationId: app.id, reason: 'OFFER_RESCINDED' },
    ]);
  });

  it('confirm-offer: ใบอื่นที่ HR_ACCEPTED → STUDENT_DECLINED (SYSTEM) + release ใน Transaction เดียวกัน', async () => {
    const studentUserId = randomUUID();
    const chosen = seed({ status: 'HR_ACCEPTED', studentUserId, quotaReserved: true });
    const other = seed({ status: 'HR_ACCEPTED', studentUserId, quotaReserved: true });
    const pending = seed({ status: 'PENDING', studentUserId });
    const unrelated = seed({ status: 'HR_ACCEPTED' });

    const outcome = await apply(chosen, { trigger: 'confirm-offer', actor: { userId: studentUserId, role: 'STUDENT' } });

    const status = (id: string) => db.state.tables.application.find((a) => a.id === id)?.status;
    expect(status(chosen.id)).to.equal('ADVISOR_PENDING');
    expect(status(other.id)).to.equal('STUDENT_DECLINED');
    expect(status(pending.id)).to.equal('PENDING');
    expect(status(unrelated.id)).to.equal('HR_ACCEPTED');
    expect(outcome.cascaded).to.have.length(1);
    expect(outcome.cascaded[0].quota[0]).to.include({ effect: 'RELEASE', applicationId: other.id });
    // ล็อกใบสมัครของนักศึกษาก่อนตรวจ Guard/cascade (กัน deadlock)
    expect(db.lockedStudents).to.include(studentUserId);
    expect(payloads().map((p) => [p.to_status, p.actor_role])).to.deep.equal([
      ['ADVISOR_PENDING', 'STUDENT'],
      ['STUDENT_DECLINED', 'SYSTEM'],
    ]);
  });

  it('approve: ใบอื่นที่ PENDING ของนักศึกษา → WITHDRAWN โดย SYSTEM', async () => {
    const studentUserId = randomUUID();
    const approved = seed({ status: 'ADVISOR_PENDING', studentUserId });
    const pending1 = seed({ status: 'PENDING', studentUserId });
    const pending2 = seed({ status: 'PENDING', studentUserId });
    await apply(approved, { trigger: 'approve', actor: { userId: approved.advisorUserId, role: 'ADVISOR' } });
    for (const id of [pending1.id, pending2.id]) {
      expect(db.state.tables.application.find((a) => a.id === id)?.status).to.equal('WITHDRAWN');
    }
    expect(db.state.tables.statusHistory.filter((h) => h.actorRole === 'SYSTEM')).to.have.length(2);
  });

  it('ยืนยันได้ทีละ 1 ที่: มีใบที่ยืนยันแล้ว ⇒ 403 ALREADY_CONFIRMED_ELSEWHERE', async () => {
    const studentUserId = randomUUID();
    seed({ status: 'ADVISOR_APPROVED', studentUserId });
    const second = seed({ status: 'HR_ACCEPTED', studentUserId });
    await expectAppError(
      apply(second, { trigger: 'confirm-offer', actor: { userId: studentUserId, role: 'STUDENT' } }),
      'ALREADY_CONFIRMED_ELSEWHERE',
      403,
    );
  });

  it('partial unique index ชน (แข่งกันยืนยัน) ⇒ แปลงเป็น 403 ALREADY_CONFIRMED_ELSEWHERE', async () => {
    const studentUserId = randomUUID();
    const first = seed({ status: 'HR_ACCEPTED', studentUserId });
    const second = seed({ status: 'HR_ACCEPTED', studentUserId });
    // จำลองว่าอีกคำขอยืนยันใบแรกสำเร็จหลังจาก Guard ของใบที่สองผ่านไปแล้ว
    const realCount = db.application.count;
    db.application.count = async () => 0;
    db.state.tables.application.find((a) => a.id === first.id)!.status = 'ADVISOR_PENDING';
    await expectAppError(
      apply(second, { trigger: 'confirm-offer', actor: { userId: studentUserId, role: 'STUDENT' } }),
      'ALREADY_CONFIRMED_ELSEWHERE',
      403,
    );
    db.application.count = realCount;
  });

  it('TERMINATED: ตั้ง terminated_by ตามผู้กระทำ, actual_end_date ไม่ส่งมา ⇒ วันนี้ (เวลาไทย), ไม่ release', async () => {
    const app = seed({ status: 'IN_PROGRESS', quotaReserved: true });
    const outcome = await apply(app, { trigger: 'terminate', actor: { userId: randomUUID(), role: 'PLATFORM_ADMIN' }, reason: 'ผิดสัญญา' });
    const row = db.state.tables.application[0];
    expect(row).to.include({ terminatedBy: 'ADMIN', terminateReason: 'ผิดสัญญา', quotaReserved: true });
    expect(row.actualEndDate.toISOString()).to.equal('2026-07-01T00:00:00.000Z');
    expect(outcome.quota).to.deep.equal([]);
  });

  it('ประเมินตามกำหนด ⇒ actual_end_date = end_date; FAIL ต้องมีเหตุผล; afterTransition อยู่ใน Transaction เดียวกัน', async () => {
    const app = seed({ status: 'IN_PROGRESS', endDate: toDateOnly('2026-06-30'), actualStartDate: toDateOnly('2026-05-01') });
    await expectAppError(apply(app, { trigger: 'evaluate', to: 'EVALUATED_FAIL', actor: hr }), 'REASON_REQUIRED');
    let written: string | undefined;
    await apply(app, {
      trigger: 'evaluate',
      to: 'EVALUATED_FAIL',
      actor: hr,
      reason: 'ขาดงานบ่อย',
      afterTransition: async (_tx, after) => {
        written = after.status;
      },
    });
    expect(written).to.equal('EVALUATED_FAIL');
    expect(db.state.tables.application[0].actualEndDate.toISOString()).to.equal('2026-06-30T00:00:00.000Z');
  });

  it('ประเมินก่อน end_date ⇒ 422 EVALUATION_NOT_OPEN', async () => {
    const app = seed({ status: 'IN_PROGRESS', endDate: toDateOnly('2026-08-31') });
    await expectAppError(apply(app, { trigger: 'evaluate', to: 'EVALUATED_PASS', actor: hr }), 'EVALUATION_NOT_OPEN', 422);
  });

  it('โต้แย้งผล FAIL: ใช้ evaluated_at ล่าสุดเป็นฐาน 7 วัน', async () => {
    const app = seed({ status: 'EVALUATED_FAIL' });
    db.state.tables.evaluation.push({ id: randomUUID(), applicationId: app.id, round: 1, evaluatedAt: new Date('2026-06-20T00:00:00Z') });
    const student = { userId: app.studentUserId, role: 'STUDENT' as const };
    await expectAppError(apply(app, { trigger: 'dispute-fail', actor: student }), 'DISPUTE_WINDOW_CLOSED', 422);
    await apply(app, { trigger: 'dispute-fail', actor: student }, new Date('2026-06-25T00:00:00Z'));
    expect(db.state.tables.application[0].status).to.equal('FAIL_DISPUTED');
  });

  it('สั่งประเมินซ้ำได้ 1 รอบ (ตั้ง reevaluation_used)', async () => {
    const app = seed({ status: 'FAIL_DISPUTED' });
    const advisor = { userId: app.advisorUserId, role: 'ADVISOR' as const };
    await apply(app, { trigger: 'request-reevaluation', actor: advisor });
    expect(db.state.tables.application[0]).to.include({ status: 'REEVALUATION_REQUESTED', reevaluationUsed: true });
    const again = makeApplication({ ...app, status: 'FAIL_DISPUTED', reevaluationUsed: true });
    db.state.tables.application[0] = again;
    await expectAppError(apply(again, { trigger: 'request-reevaluation', actor: advisor }), 'STATE_CONFLICT');
  });

  it('บันทึกผลวิชา: บริษัท FAIL ⇒ ห้าม ACADEMIC_PASS, หลังหน้าต่างปิดบันทึก REPEAT_REQUIRED ได้ → COMPLETED', async () => {
    const app = seed({ status: 'EVALUATED_FAIL' });
    db.state.tables.evaluation.push({ id: randomUUID(), applicationId: app.id, round: 1, evaluatedAt: new Date('2026-06-01T00:00:00Z') });
    const advisor = { userId: app.advisorUserId, role: 'ADVISOR' as const };
    await expectAppError(
      apply(app, { trigger: 'academic-result', actor: advisor, input: { academicResult: 'ACADEMIC_PASS' } }),
      'VALIDATION_FAILED',
      400,
    );
    await apply(app, { trigger: 'academic-result', actor: advisor, input: { academicResult: 'REPEAT_REQUIRED' }, patch: { academicNote: 'ฝึกใหม่เทอมหน้า' } });
    expect(db.state.tables.application[0]).to.include({
      status: 'COMPLETED',
      academicResult: 'REPEAT_REQUIRED',
      academicNote: 'ฝึกใหม่เทอมหน้า',
    });
    expect(db.state.tables.application[0].academicRecordedAt.getTime()).to.equal(NOW.getTime());
  });

  it('TERMINATED/NO_EVALUATION: บันทึกผลวิชาโดยไม่เปลี่ยนสถานะ ไม่มี history/E08 และบันทึกได้ครั้งเดียว', async () => {
    const app = seed({ status: 'TERMINATED' });
    const after = await service.recordAcademicResultWithoutTransition(db as any, app, 'ACADEMIC_FAIL', null, NOW);
    expect(after).to.include({ status: 'TERMINATED', academicResult: 'ACADEMIC_FAIL' });
    expect(db.state.tables.statusHistory).to.deep.equal([]);
    expect(db.state.tables.outboxEvent).to.deep.equal([]);
    await expectAppError(
      service.recordAcademicResultWithoutTransition(db as any, app, 'ACADEMIC_PASS', null, NOW),
      'STATE_CONFLICT',
    );
    await expectAppError(
      service.recordAcademicResultWithoutTransition(db as any, seed({ status: 'IN_PROGRESS' }), 'ACADEMIC_PASS', null, NOW),
      'STATE_CONFLICT',
    );
  });

  it('ประกาศถูกตีกลับหลังอนุมัติ ⇒ ติดธง flagged_for_advisor โดยไม่เปลี่ยนสถานะ (ADVISOR_APPROVED/IN_PROGRESS เท่านั้น)', async () => {
    const approved = seed({ status: 'ADVISOR_APPROVED' });
    const pending = seed({ status: 'PENDING' });
    expect(await service.flagForAdvisor(db as any, approved.id)).to.equal(true);
    expect(await service.flagForAdvisor(db as any, approved.id)).to.equal(false);
    expect(await service.flagForAdvisor(db as any, pending.id)).to.equal(false);
    expect(db.state.tables.application[0]).to.include({ status: 'ADVISOR_APPROVED', flaggedForAdvisor: true });
    expect(db.state.tables.outboxEvent).to.deep.equal([]);
  });

  it('ใบสมัครที่ถูก Freeze อยู่: เปลี่ยนสถานะแล้วเริ่มนับช่วง Freeze ใหม่จากตอนนี้', async () => {
    const app = seed({ status: 'PENDING', frozen: true, frozenAt: new Date('2026-06-10T00:00:00Z'), slaPausedSeconds: 500 });
    await apply(app, { trigger: 'withdraw', actor: { userId: app.studentUserId, role: 'STUDENT' } });
    expect(db.state.tables.application[0].frozenAt.getTime()).to.equal(NOW.getTime());
    expect(db.state.tables.application[0].slaPausedSeconds).to.equal(0);
  });
});
