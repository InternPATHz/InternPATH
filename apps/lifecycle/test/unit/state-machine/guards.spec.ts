import { expect } from 'chai';
import { bangkokToday, daysBetween, toDateOnly } from '../../../src/state-machine/dates';
import { mapApplicationUniqueViolation } from '../../../src/state-machine/errors';
import {
  allowedAcademicResults,
  checkGuards,
  noEvaluationBaseDate,
  startWarning,
  type GuardApplication,
  type GuardContext,
} from '../../../src/state-machine/guards';

const CONFIG = { minActualDays: 30, disputeWindowDays: 7, noEvaluationAfterDays: 14 };
const DAY = 86_400_000;

function app(overrides: Partial<GuardApplication> = {}): GuardApplication {
  return {
    status: 'IN_PROGRESS',
    frozen: false,
    startDate: toDateOnly('2026-06-01'),
    endDate: toDateOnly('2026-08-31'),
    actualStartDate: toDateOnly('2026-06-01'),
    actualEndDate: null,
    reevaluationUsed: false,
    statusChangedAt: new Date('2026-06-01T00:00:00Z'),
    ...overrides,
  };
}

function ctx(overrides: Partial<GuardContext> = {}): GuardContext {
  return { application: app(), now: new Date('2026-09-01T03:00:00Z'), config: CONFIG, ...overrides };
}

describe('State Machine — วันที่ (Asia/Bangkok)', () => {
  it('bangkokToday ข้ามวันตามเวลาไทย ไม่ใช่ UTC', () => {
    // 2026-08-30T17:30Z = 31 ส.ค. 00:30 น. เวลาไทย
    expect(bangkokToday(new Date('2026-08-30T17:30:00Z')).toISOString()).to.equal('2026-08-31T00:00:00.000Z');
    expect(bangkokToday(new Date('2026-08-30T16:59:00Z')).toISOString()).to.equal('2026-08-30T00:00:00.000Z');
  });

  it('daysBetween นับตามวันที่', () => {
    expect(daysBetween('2026-06-01', '2026-07-01')).to.equal(30);
    expect(daysBetween('2026-06-01', '2026-06-30')).to.equal(29);
    expect(() => toDateOnly('2026/06/01')).to.throw(RangeError);
  });
});

describe('State Machine — Guard', () => {
  it('reasonRequired: ช่องว่างล้วนถือว่าไม่มีเหตุผล', () => {
    expect(checkGuards(['reasonRequired'], ctx({ input: { reason: '   ' } }))?.code).to.equal('REASON_REQUIRED');
    expect(checkGuards(['reasonRequired'], ctx({ input: { reason: 'ย้ายที่ฝึก' } }))).to.equal(null);
  });

  it('periodMin30Days: ห่าง 29 วัน ⇒ 422 INVALID_PERIOD_MIN_30_DAYS, 30 วันผ่าน, ไม่ส่งวันที่ ⇒ 400', () => {
    const failure = checkGuards(
      ['periodMin30Days'],
      ctx({ input: { startDate: toDateOnly('2026-06-01'), endDate: toDateOnly('2026-06-30') } }),
    );
    expect(failure?.code).to.equal('INVALID_PERIOD_MIN_30_DAYS');
    expect(failure?.getStatus()).to.equal(422);
    expect(
      checkGuards(['periodMin30Days'], ctx({ input: { startDate: toDateOnly('2026-06-01'), endDate: toDateOnly('2026-07-01') } })),
    ).to.equal(null);
    expect(checkGuards(['periodMin30Days'], ctx({ input: {} }))?.code).to.equal('VALIDATION_FAILED');
  });

  it('notConfirmedElsewhere ⇒ 403 ALREADY_CONFIRMED_ELSEWHERE', () => {
    const failure = checkGuards(['notConfirmedElsewhere'], ctx({ studentHasOtherConfirmed: true }));
    expect(failure?.code).to.equal('ALREADY_CONFIRMED_ELSEWHERE');
    expect(failure?.getStatus()).to.equal(403);
  });

  it('notFrozen: ประกาศถูก Freeze ⇒ 409 STATE_CONFLICT (JOB_FROZEN)', () => {
    const failure = checkGuards(['notFrozen'], ctx({ application: app({ status: 'PENDING', frozen: true }) }));
    expect(failure?.code).to.equal('STATE_CONFLICT');
    expect(failure?.details?.[0]?.issue).to.equal('JOB_FROZEN');
  });

  it('endDateReached: ก่อน end_date (เวลาไทย) ⇒ 422 EVALUATION_NOT_OPEN', () => {
    // 30 ส.ค. 23:00 เวลาไทย = ยังไม่ถึง 31 ส.ค.
    expect(checkGuards(['endDateReached'], ctx({ now: new Date('2026-08-30T16:00:00Z') }))?.code).to.equal(
      'EVALUATION_NOT_OPEN',
    );
    // 31 ส.ค. 00:30 เวลาไทย = ถึง end_date แล้ว
    expect(checkGuards(['endDateReached'], ctx({ now: new Date('2026-08-30T17:30:00Z') }))).to.equal(null);
  });

  it('terminatedAfterMinDays: ฝึกจริง 29 วันประเมินไม่ได้, 30 วันประเมินได้', () => {
    const at = (end: string) =>
      checkGuards(['terminatedAfterMinDays'], ctx({ application: app({ status: 'TERMINATED', actualEndDate: toDateOnly(end) }) }));
    expect(at('2026-06-30')?.code).to.equal('EVALUATION_NOT_OPEN');
    expect(at('2026-07-01')).to.equal(null);
  });

  it('disputeWindowOpen: ภายใน 7 วันโต้แย้งได้, เลย ⇒ 422 DISPUTE_WINDOW_CLOSED, โต้แย้งซ้ำ ⇒ 409', () => {
    const evaluatedAt = new Date('2026-09-01T00:00:00Z');
    const base = { application: app({ status: 'EVALUATED_FAIL' }), lastEvaluatedAt: evaluatedAt };
    expect(checkGuards(['disputeWindowOpen'], ctx({ ...base, now: new Date(evaluatedAt.getTime() + 7 * DAY) }))).to.equal(null);
    expect(
      checkGuards(['disputeWindowOpen'], ctx({ ...base, now: new Date(evaluatedAt.getTime() + 7 * DAY + 1) }))?.code,
    ).to.equal('DISPUTE_WINDOW_CLOSED');
    expect(
      checkGuards(['disputeWindowOpen'], ctx({ ...base, now: evaluatedAt, disputedSinceLastEvaluation: true }))?.details?.[0]
        ?.issue,
    ).to.equal('ALREADY_DISPUTED');
  });

  it('disputeWindowClosed: บันทึกผลวิชาของ FAIL ได้เมื่อหน้าต่างปิด หรือโต้แย้งจบแล้ว', () => {
    const evaluatedAt = new Date('2026-09-01T00:00:00Z');
    const base = { application: app({ status: 'EVALUATED_FAIL' }), lastEvaluatedAt: evaluatedAt };
    expect(checkGuards(['disputeWindowClosed'], ctx({ ...base, now: new Date(evaluatedAt.getTime() + DAY) }))?.details?.[0]?.issue).to.equal(
      'DISPUTE_WINDOW_OPEN',
    );
    expect(checkGuards(['disputeWindowClosed'], ctx({ ...base, now: new Date(evaluatedAt.getTime() + 8 * DAY) }))).to.equal(null);
    expect(
      checkGuards(['disputeWindowClosed'], ctx({ ...base, now: evaluatedAt, disputeResolvedSinceLastEvaluation: true })),
    ).to.equal(null);
  });

  it('reevaluationNotUsed: ประเมินซ้ำได้ 1 รอบ', () => {
    expect(checkGuards(['reevaluationNotUsed'], ctx({ application: app({ reevaluationUsed: true }) }))?.details?.[0]?.issue).to.equal(
      'REEVALUATION_ALREADY_USED',
    );
  });

  it('academicResultAllowed: บริษัท PASS ⇒ ได้ทั้ง 3 ค่า, FAIL ⇒ ห้ามเป็น ACADEMIC_PASS (UAT-21)', () => {
    expect(allowedAcademicResults('EVALUATED_PASS')).to.have.members(['ACADEMIC_PASS', 'ACADEMIC_FAIL', 'REPEAT_REQUIRED']);
    expect(allowedAcademicResults('EVALUATED_FAIL')).to.have.members(['ACADEMIC_FAIL', 'REPEAT_REQUIRED']);
    const failCtx = (academicResult: 'ACADEMIC_PASS' | 'REPEAT_REQUIRED') =>
      ctx({ application: app({ status: 'EVALUATED_FAIL' }), input: { academicResult } });
    expect(checkGuards(['academicResultAllowed'], failCtx('ACADEMIC_PASS'))?.details?.[0]?.issue).to.equal(
      'COMPANY_FAIL_CANNOT_BECOME_PASS',
    );
    expect(checkGuards(['academicResultAllowed'], failCtx('REPEAT_REQUIRED'))).to.equal(null);
    expect(
      checkGuards(['academicResultAllowed'], ctx({ application: app({ status: 'EVALUATED_PASS' }), input: { academicResult: 'ACADEMIC_FAIL' } })),
    ).to.equal(null);
  });

  it('evaluationOverdue: Admin ยืนยัน NO_EVALUATION ได้เมื่อเลย end_date 14 วัน', () => {
    expect(checkGuards(['evaluationOverdue'], ctx({ now: new Date('2026-09-13T03:00:00Z') }))?.code).to.equal('STATE_CONFLICT');
    expect(checkGuards(['evaluationOverdue'], ctx({ now: new Date('2026-09-14T03:00:00Z') }))).to.equal(null);
  });

  it('evaluationOverdue: วันฐานตามสถานะ (PM รีวิว PR #36) — TERMINATED ใช้ actual_end_date, REEVALUATION_REQUESTED ใช้วันที่สั่งประเมินใหม่ (เวลาไทย)', () => {
    const terminated = app({ status: 'TERMINATED', actualEndDate: toDateOnly('2026-07-10') });
    expect(noEvaluationBaseDate(terminated)?.toISOString()).to.equal('2026-07-10T00:00:00.000Z');
    expect(checkGuards(['evaluationOverdue'], ctx({ application: terminated, now: new Date('2026-07-23T03:00:00Z') }))?.code).to.equal(
      'STATE_CONFLICT',
    );
    // วันที่ 14 ยืนยันได้ (>=)
    expect(checkGuards(['evaluationOverdue'], ctx({ application: terminated, now: new Date('2026-07-24T03:00:00Z') }))).to.equal(null);

    // สั่งประเมินใหม่ 1 ต.ค. 00:30 เวลาไทย (= 30 ก.ย. 17:30Z) ⇒ ฐานคือ 1 ต.ค.
    const reeval = app({ status: 'REEVALUATION_REQUESTED', statusChangedAt: new Date('2026-09-30T17:30:00Z') });
    expect(noEvaluationBaseDate(reeval)?.toISOString()).to.equal('2026-10-01T00:00:00.000Z');
    expect(checkGuards(['evaluationOverdue'], ctx({ application: reeval, now: new Date('2026-10-14T03:00:00Z') }))?.code).to.equal(
      'STATE_CONFLICT',
    );
    expect(checkGuards(['evaluationOverdue'], ctx({ application: reeval, now: new Date('2026-10-15T03:00:00Z') }))).to.equal(null);

    // ไม่มีวันฐาน ⇒ ยืนยันไม่ได้
    expect(
      checkGuards(['evaluationOverdue'], ctx({ application: app({ status: 'TERMINATED', actualEndDate: null }) }))?.details?.[0]?.issue,
    ).to.equal('NO_EVALUATION_BASE_DATE_MISSING');
    expect(noEvaluationBaseDate(app({ status: 'EVALUATED_PASS' }))).to.equal(null);
  });

  it('probe ข้าม Guard ที่ต้องใช้ input แต่ execute ตรวจครบ', () => {
    const guards = ['reasonRequired', 'endDateReached'] as const;
    expect(checkGuards(guards, ctx(), 'probe')).to.equal(null);
    expect(checkGuards(guards, ctx(), 'execute')?.code).to.equal('REASON_REQUIRED');
  });

  it('startWarning: end_date − actual_start_date < 30 ⇒ NO_CERTIFICATE_ELIGIBLE (UAT-35)', () => {
    expect(startWarning(toDateOnly('2026-08-05'), toDateOnly('2026-08-31'), 30)).to.equal('NO_CERTIFICATE_ELIGIBLE');
    expect(startWarning(toDateOnly('2026-08-01'), toDateOnly('2026-08-31'), 30)).to.equal(undefined);
  });
});

describe('State Machine — แปลง unique violation ของ partial unique index', () => {
  it('ยืนยันได้ทีละ 1 ที่ ⇒ 403 ALREADY_CONFIRMED_ELSEWHERE (ทั้งชื่อ index และรายชื่อคอลัมน์)', () => {
    for (const error of [
      { code: 'P2002', meta: { target: 'applications_one_active_confirmation_per_student' } },
      { code: 'P2002', meta: { target: ['student_user_id'] } },
      { code: '23505', constraint: 'applications_one_active_confirmation_per_student' },
    ]) {
      expect(mapApplicationUniqueViolation(error)?.code).to.equal('ALREADY_CONFIRMED_ELSEWHERE');
    }
  });

  it('สมัครซ้ำประกาศเดิม ⇒ 409 ALREADY_APPLIED', () => {
    expect(mapApplicationUniqueViolation({ code: 'P2002', meta: { target: ['student_user_id', 'job_id'] } })?.code).to.equal(
      'ALREADY_APPLIED',
    );
    expect(
      mapApplicationUniqueViolation({ code: 'P2002', message: 'Unique constraint failed: applications_no_duplicate_active_per_job' })
        ?.code,
    ).to.equal('ALREADY_APPLIED');
  });

  it('error อื่นไม่แปลง', () => {
    expect(mapApplicationUniqueViolation(new Error('boom'))).to.equal(undefined);
    expect(mapApplicationUniqueViolation({ code: 'P2002', meta: { target: ['certificate_code'] } })).to.equal(undefined);
    expect(mapApplicationUniqueViolation(null)).to.equal(undefined);
  });
});
