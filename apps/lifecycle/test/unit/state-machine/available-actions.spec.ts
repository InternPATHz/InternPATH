import { expect } from 'chai';
import { computeAvailableActions, type AvailableActionsContext } from '../../../src/state-machine/available-actions';
import { toDateOnly } from '../../../src/state-machine/dates';
import type { GuardApplication } from '../../../src/state-machine/guards';

const CONFIG = { minActualDays: 30, disputeWindowDays: 7, noEvaluationAfterDays: 14 };

function ctx(app: Partial<GuardApplication>, extra: Partial<AvailableActionsContext> = {}): AvailableActionsContext {
  return {
    application: {
      status: 'PENDING',
      frozen: false,
      startDate: toDateOnly('2026-06-01'),
      endDate: toDateOnly('2026-08-31'),
      actualStartDate: null,
      actualEndDate: null,
      reevaluationUsed: false,
      ...app,
    },
    now: new Date('2026-07-01T03:00:00Z'),
    config: CONFIG,
    ...extra,
  };
}

describe('State Machine — available_actions[]', () => {
  it('PENDING: HR ตอบรับ/ปฏิเสธได้, นักศึกษาถอนได้, อาจารย์ไม่มีปุ่ม', () => {
    expect(computeAvailableActions('COMPANY_HR', ctx({})).available_actions).to.have.members(['accept', 'reject']);
    expect(computeAvailableActions('STUDENT', ctx({})).available_actions).to.deep.equal(['withdraw']);
    expect(computeAvailableActions('ADVISOR', ctx({})).available_actions).to.deep.equal([]);
  });

  it('นักศึกษายืนยันที่อื่นอยู่ ⇒ ไม่มี accept และมี accept_blocked_reason', () => {
    const result = computeAvailableActions('COMPANY_HR', ctx({}, { studentHasOtherConfirmed: true }));
    expect(result.available_actions).to.deep.equal(['reject']);
    expect(result.accept_blocked_reason).to.equal('ALREADY_CONFIRMED_ELSEWHERE');
  });

  it('ประกาศถูก Freeze ⇒ ปุ่ม accept ปิด (JOB_FROZEN)', () => {
    const result = computeAvailableActions('COMPANY_HR', ctx({ frozen: true }));
    expect(result.available_actions).to.not.include('accept');
    expect(result.accept_blocked_reason).to.equal('JOB_FROZEN');
  });

  it('HR_ACCEPTED: นักศึกษายืนยัน/ปฏิเสธข้อเสนอได้, HR ถอนข้อเสนอได้', () => {
    expect(computeAvailableActions('STUDENT', ctx({ status: 'HR_ACCEPTED' })).available_actions).to.have.members([
      'confirm-offer',
      'decline-offer',
    ]);
    expect(computeAvailableActions('COMPANY_HR', ctx({ status: 'HR_ACCEPTED' })).available_actions).to.deep.equal([
      'rescind-offer',
    ]);
  });

  it('IN_PROGRESS ก่อน end_date: HR ยุติได้แต่ยังประเมินไม่ได้; หลัง end_date ประเมินได้ (ปุ่มเดียว)', () => {
    expect(computeAvailableActions('COMPANY_HR', ctx({ status: 'IN_PROGRESS' })).available_actions).to.deep.equal(['terminate']);
    const after = computeAvailableActions('COMPANY_HR', ctx({ status: 'IN_PROGRESS' }, { now: new Date('2026-09-01T03:00:00Z') }));
    expect(after.available_actions).to.have.members(['terminate', 'evaluate']);
    expect(after.available_actions.filter((a) => a === 'evaluate')).to.have.length(1);
  });

  it('IN_PROGRESS: นักศึกษาขอยุติได้แต่ถอนไม่ได้; อาจารย์ terminate/continue เฉพาะเมื่อบริษัทถูกระงับ', () => {
    expect(computeAvailableActions('STUDENT', ctx({ status: 'IN_PROGRESS' })).available_actions).to.deep.equal([
      'request-termination',
    ]);
    expect(computeAvailableActions('ADVISOR', ctx({ status: 'IN_PROGRESS' })).available_actions).to.deep.equal([]);
    expect(
      computeAvailableActions('ADVISOR', ctx({ status: 'IN_PROGRESS' }, { companySuspendedDecision: 'PENDING' })).available_actions,
    ).to.have.members(['terminate', 'continue']);
  });

  it('EVALUATED_FAIL: นักศึกษาโต้แย้งได้ในหน้าต่าง 7 วัน, อาจารย์บันทึกผลวิชาได้หลังหน้าต่างปิด', () => {
    const evaluatedAt = new Date('2026-09-01T00:00:00Z');
    const inWindow = ctx({ status: 'EVALUATED_FAIL' }, { lastEvaluatedAt: evaluatedAt, now: new Date('2026-09-03T00:00:00Z') });
    const afterWindow = { ...inWindow, now: new Date('2026-09-09T00:00:00Z') };
    expect(computeAvailableActions('STUDENT', inWindow).available_actions).to.deep.equal(['dispute-fail']);
    expect(computeAvailableActions('ADVISOR', inWindow).available_actions).to.deep.equal([]);
    expect(computeAvailableActions('STUDENT', afterWindow).available_actions).to.deep.equal([]);
    expect(computeAvailableActions('ADVISOR', afterWindow).available_actions).to.deep.equal(['academic-result']);
  });

  it('FAIL_DISPUTED: อาจารย์สั่งประเมินซ้ำได้ครั้งเดียว', () => {
    expect(computeAvailableActions('ADVISOR', ctx({ status: 'FAIL_DISPUTED' })).available_actions).to.have.members([
      'request-reevaluation',
      'uphold-fail',
    ]);
    expect(
      computeAvailableActions('ADVISOR', ctx({ status: 'FAIL_DISPUTED', reevaluationUsed: true })).available_actions,
    ).to.deep.equal(['uphold-fail']);
  });

  it('TERMINATED / NO_EVALUATION: อาจารย์บันทึกผลวิชาได้ครั้งเดียว; HR ประเมินต่อได้เมื่อฝึกจริง ≥ 30 วัน', () => {
    expect(computeAvailableActions('ADVISOR', ctx({ status: 'TERMINATED' })).available_actions).to.deep.equal(['academic-result']);
    expect(
      computeAvailableActions('ADVISOR', ctx({ status: 'NO_EVALUATION' }, { academicResult: 'ACADEMIC_FAIL' })).available_actions,
    ).to.deep.equal([]);
    const terminated = (end: string) =>
      computeAvailableActions(
        'COMPANY_HR',
        ctx({ status: 'TERMINATED', actualStartDate: toDateOnly('2026-06-01'), actualEndDate: toDateOnly(end) }),
      ).available_actions;
    expect(terminated('2026-06-20')).to.deep.equal([]);
    expect(terminated('2026-07-15')).to.deep.equal(['evaluate']);
  });

  it('Admin: ยุติได้ระหว่างฝึก และยืนยัน NO_EVALUATION ได้เมื่อเลย end_date 14 วัน', () => {
    expect(computeAvailableActions('PLATFORM_ADMIN', ctx({ status: 'IN_PROGRESS' })).available_actions).to.deep.equal(['terminate']);
    expect(
      computeAvailableActions('PLATFORM_ADMIN', ctx({ status: 'IN_PROGRESS' }, { now: new Date('2026-09-15T03:00:00Z') }))
        .available_actions,
    ).to.have.members(['terminate', 'confirm-no-evaluation']);
  });

  it('สถานะปลายทาง ไม่มีปุ่มสำหรับทุก role', () => {
    for (const role of ['STUDENT', 'COMPANY_HR', 'ADVISOR', 'PLATFORM_ADMIN'] as const) {
      expect(computeAvailableActions(role, ctx({ status: 'COMPLETED' })).available_actions, role).to.deep.equal([]);
      expect(computeAvailableActions(role, ctx({ status: 'WITHDRAWN' })).available_actions, role).to.deep.equal([]);
    }
  });
});
