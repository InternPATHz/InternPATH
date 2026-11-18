import type { ActorRole, ApplicationStatus } from '@internpath/contracts';
import { expect } from 'chai';
import {
  CONFIRMED_STATUSES,
  DELETION_BLOCKING_STATUSES,
  INACTIVE_STATUSES,
  NO_EVALUATION_SOURCE_STATUSES,
  TRANSITIONS,
  findTransition,
  isTransitionAllowed,
  transitionsFrom,
} from '../../../src/state-machine/transition-table';

const ALL_STATUSES: ApplicationStatus[] = [
  'PENDING',
  'HR_ACCEPTED',
  'ADVISOR_PENDING',
  'ADVISOR_APPROVED',
  'IN_PROGRESS',
  'EVALUATED_PASS',
  'EVALUATED_FAIL',
  'FAIL_DISPUTED',
  'REEVALUATION_REQUESTED',
  'COMPLETED',
  'TERMINATED',
  'NO_EVALUATION',
  'HR_REJECTED',
  'STUDENT_DECLINED',
  'ADVISOR_REJECTED',
  'OFFER_RESCINDED',
  'WITHDRAWN',
  'EXPIRED',
  'CANCELLED',
];
const ALL_ACTORS: ActorRole[] = ['STUDENT', 'COMPANY_HR', 'ADVISOR', 'PLATFORM_ADMIN', 'SYSTEM'];

/**
 * คัดลอกจาก docs/data-schema.md §8.1 (Transition Table) ทีละแถว: [from, to, actors]
 * ถ้าเอกสารเปลี่ยน ให้แก้ทั้งรายการนี้และ src/state-machine/transition-table.ts
 */
const DOC_TABLE: Array<[ApplicationStatus, ApplicationStatus, ActorRole[]]> = [
  ['PENDING', 'HR_ACCEPTED', ['COMPANY_HR']],
  ['PENDING', 'HR_REJECTED', ['COMPANY_HR']],
  ['PENDING', 'WITHDRAWN', ['STUDENT', 'SYSTEM']],
  ['PENDING', 'EXPIRED', ['SYSTEM']],
  ['PENDING', 'CANCELLED', ['SYSTEM']],
  ['HR_ACCEPTED', 'ADVISOR_PENDING', ['STUDENT']],
  ['HR_ACCEPTED', 'STUDENT_DECLINED', ['STUDENT', 'SYSTEM']],
  ['HR_ACCEPTED', 'EXPIRED', ['SYSTEM']],
  ['HR_ACCEPTED', 'OFFER_RESCINDED', ['COMPANY_HR']],
  ['HR_ACCEPTED', 'CANCELLED', ['SYSTEM']],
  ['ADVISOR_PENDING', 'ADVISOR_APPROVED', ['ADVISOR']],
  ['ADVISOR_PENDING', 'ADVISOR_REJECTED', ['ADVISOR']],
  ['ADVISOR_PENDING', 'WITHDRAWN', ['STUDENT']],
  ['ADVISOR_PENDING', 'OFFER_RESCINDED', ['COMPANY_HR']],
  ['ADVISOR_PENDING', 'CANCELLED', ['SYSTEM']],
  ['ADVISOR_APPROVED', 'IN_PROGRESS', ['COMPANY_HR']],
  ['ADVISOR_APPROVED', 'WITHDRAWN', ['STUDENT']],
  ['ADVISOR_APPROVED', 'OFFER_RESCINDED', ['COMPANY_HR']],
  ['ADVISOR_APPROVED', 'EXPIRED', ['SYSTEM']],
  ['IN_PROGRESS', 'TERMINATED', ['COMPANY_HR', 'STUDENT', 'ADVISOR', 'PLATFORM_ADMIN']],
  ['IN_PROGRESS', 'EVALUATED_PASS', ['COMPANY_HR']],
  ['IN_PROGRESS', 'EVALUATED_FAIL', ['COMPANY_HR']],
  ['TERMINATED', 'EVALUATED_PASS', ['COMPANY_HR']],
  ['TERMINATED', 'EVALUATED_FAIL', ['COMPANY_HR']],
  ['IN_PROGRESS', 'NO_EVALUATION', ['PLATFORM_ADMIN']],
  // เพิ่มตาม PM ตัดสินในรีวิว PR #36
  ['TERMINATED', 'NO_EVALUATION', ['PLATFORM_ADMIN']],
  ['REEVALUATION_REQUESTED', 'NO_EVALUATION', ['PLATFORM_ADMIN']],
  ['EVALUATED_FAIL', 'FAIL_DISPUTED', ['STUDENT']],
  ['FAIL_DISPUTED', 'REEVALUATION_REQUESTED', ['ADVISOR']],
  ['FAIL_DISPUTED', 'EVALUATED_FAIL', ['ADVISOR']],
  ['REEVALUATION_REQUESTED', 'EVALUATED_PASS', ['COMPANY_HR']],
  ['REEVALUATION_REQUESTED', 'EVALUATED_FAIL', ['COMPANY_HR']],
  ['EVALUATED_PASS', 'COMPLETED', ['ADVISOR']],
  ['EVALUATED_FAIL', 'COMPLETED', ['ADVISOR']],
];

describe('State Machine — Transition Table (data-schema §8.1)', () => {
  it('ทุกแถวในเอกสารมีในโค้ด และผู้กระทำตรงกัน', () => {
    for (const [from, to, actors] of DOC_TABLE) {
      for (const actor of actors) {
        expect(isTransitionAllowed(from, to, actor), `${from} → ${to} โดย ${actor}`).to.equal(true);
      }
    }
  });

  it('คู่สถานะ × ผู้กระทำที่ไม่อยู่ในตารางต้องถูกปฏิเสธทั้งหมด (19 × 19 × 5)', () => {
    const allowed = new Set(DOC_TABLE.flatMap(([from, to, actors]) => actors.map((a) => `${from}>${to}>${a}`)));
    let checked = 0;
    for (const from of ALL_STATUSES) {
      for (const to of ALL_STATUSES) {
        for (const actor of ALL_ACTORS) {
          checked++;
          expect(isTransitionAllowed(from, to, actor), `${from} → ${to} โดย ${actor}`).to.equal(
            allowed.has(`${from}>${to}>${actor}`),
          );
        }
      }
    }
    expect(checked).to.equal(19 * 19 * 5);
  });

  it('(from, trigger, actor, to) ไม่ซ้ำกัน และ trigger ระบุปลายทางได้ชัดเจน', () => {
    const keys = TRANSITIONS.flatMap((r) => r.actors.map((a) => `${r.from}|${r.trigger}|${a}|${r.to}`));
    expect(new Set(keys).size).to.equal(keys.length);
    // trigger ที่มีหลายปลายทางจากสถานะเดียวกันมีแค่ evaluate (PASS/FAIL)
    const multi = TRANSITIONS.filter(
      (r) => TRANSITIONS.filter((o) => o.from === r.from && o.trigger === r.trigger && o.to !== r.to).length > 0,
    ).map((r) => r.trigger);
    expect([...new Set(multi)]).to.deep.equal(['evaluate']);
  });

  it('สถานะปลายทางไม่มีทางออก ยกเว้น TERMINATED ที่ประเมินต่อได้หรือ Admin ยืนยัน NO_EVALUATION', () => {
    for (const status of INACTIVE_STATUSES) {
      const out = transitionsFrom(status).map((r) => r.to);
      if (status === 'TERMINATED') expect(out).to.have.members(['EVALUATED_PASS', 'EVALUATED_FAIL', 'NO_EVALUATION']);
      else expect(out, status).to.deep.equal([]);
    }
  });

  it('NO_EVALUATION: Admin ยืนยันได้จาก 3 สถานะ, TERMINATED ต้องฝึกจริง ≥ 30 วัน', () => {
    expect([...NO_EVALUATION_SOURCE_STATUSES]).to.have.members(
      TRANSITIONS.filter((r) => r.to === 'NO_EVALUATION').map((r) => r.from),
    );
    expect([...NO_EVALUATION_SOURCE_STATUSES]).to.have.members(['IN_PROGRESS', 'TERMINATED', 'REEVALUATION_REQUESTED']);
    for (const r of TRANSITIONS.filter((x) => x.to === 'NO_EVALUATION')) {
      expect(r.trigger).to.equal('confirm-no-evaluation');
      expect(r.guards).to.include('evaluationOverdue');
    }
    expect(findTransition('TERMINATED', 'confirm-no-evaluation', 'PLATFORM_ADMIN')?.guards).to.include('terminatedAfterMinDays');
  });

  it('เส้นทางหลัก §5.2: สมัคร → ตอบรับ → ยืนยัน → อนุมัติ → เริ่มงาน → ประเมิน → จบ', () => {
    const path: Array<[ApplicationStatus, Parameters<typeof findTransition>[1], ActorRole, ApplicationStatus]> = [
      ['PENDING', 'accept', 'COMPANY_HR', 'HR_ACCEPTED'],
      ['HR_ACCEPTED', 'confirm-offer', 'STUDENT', 'ADVISOR_PENDING'],
      ['ADVISOR_PENDING', 'approve', 'ADVISOR', 'ADVISOR_APPROVED'],
      ['ADVISOR_APPROVED', 'start', 'COMPANY_HR', 'IN_PROGRESS'],
      ['IN_PROGRESS', 'evaluate', 'COMPANY_HR', 'EVALUATED_PASS'],
      ['EVALUATED_PASS', 'academic-result', 'ADVISOR', 'COMPLETED'],
    ];
    for (const [from, trigger, actor, to] of path) {
      expect(findTransition(from, trigger, actor, to)?.to, `${from} --${trigger}-->`).to.equal(to);
    }
  });

  it('โควตา: reserve ตอน HR ตอบรับ, confirm ตอนเริ่มงาน, release ทุกทางออกหลังจองแล้ว (ยกเว้นหลัง confirm)', () => {
    expect(TRANSITIONS.filter((r) => r.quota === 'RESERVE').map((r) => `${r.from}>${r.to}`)).to.deep.equal([
      'PENDING>HR_ACCEPTED',
    ]);
    expect(TRANSITIONS.filter((r) => r.quota === 'CONFIRM').map((r) => `${r.from}>${r.to}`)).to.deep.equal([
      'ADVISOR_APPROVED>IN_PROGRESS',
    ]);
    const reservedStates: ApplicationStatus[] = ['HR_ACCEPTED', 'ADVISOR_PENDING', 'ADVISOR_APPROVED'];
    for (const r of TRANSITIONS) {
      const leavesReservation = reservedStates.includes(r.from) && !reservedStates.includes(r.to) && r.to !== 'IN_PROGRESS';
      expect(r.quota === 'RELEASE', `${r.from} → ${r.to} (${r.trigger})`).to.equal(leavesReservation);
    }
  });

  it('ถอนข้อเสนอ/อาจารย์ไม่อนุมัติ/ยุติ ต้องมีเหตุผล', () => {
    for (const r of TRANSITIONS) {
      const mustHaveReason = ['OFFER_RESCINDED', 'ADVISOR_REJECTED', 'TERMINATED'].includes(r.to);
      if (mustHaveReason) expect(r.guards, `${r.from} → ${r.to}`).to.include('reasonRequired');
    }
    // ผลประเมิน FAIL ของ HR ต้องมีเหตุผล (ยืนยันผลเดิมโดยอาจารย์ไม่ต้อง)
    for (const r of TRANSITIONS.filter((x) => x.trigger === 'evaluate' && x.to === 'EVALUATED_FAIL')) {
      expect(r.guards).to.include('reasonRequired');
    }
  });

  it('Side effect ของการยืนยัน/อนุมัติ และ Guard สำคัญ', () => {
    expect(findTransition('HR_ACCEPTED', 'confirm-offer', 'STUDENT')?.cascade).to.equal('DECLINE_OTHER_OFFERS');
    expect(findTransition('ADVISOR_PENDING', 'approve', 'ADVISOR')?.cascade).to.equal('WITHDRAW_OTHER_PENDING');
    expect(findTransition('PENDING', 'accept', 'COMPANY_HR')?.guards).to.include.members([
      'notFrozen',
      'notConfirmedElsewhere',
      'periodMin30Days',
    ]);
    expect(findTransition('TERMINATED', 'evaluate', 'COMPANY_HR', 'EVALUATED_PASS')?.guards).to.include(
      'terminatedAfterMinDays',
    );
    expect(findTransition('EVALUATED_FAIL', 'academic-result', 'ADVISOR')?.guards).to.include('disputeWindowClosed');
    expect(findTransition('FAIL_DISPUTED', 'request-reevaluation', 'ADVISOR')?.guards).to.include(
      'reevaluationNotUsed',
    );
  });

  it('CONFIRMED_STATUSES ตรงกับ partial unique index "ยืนยันได้ทีละ 1 ที่"', () => {
    expect([...CONFIRMED_STATUSES]).to.deep.equal(['ADVISOR_PENDING', 'ADVISOR_APPROVED', 'IN_PROGRESS']);
  });

  it('ลบบัญชี (api-contract §9 / data-schema §2.3): ใบที่ยังไม่ถึง ADVISOR_PENDING ถูกยกเลิก ส่วนที่เหลือบล็อกการลบ', () => {
    expect([...DELETION_BLOCKING_STATUSES]).to.deep.equal([
      'ADVISOR_PENDING',
      'ADVISOR_APPROVED',
      'IN_PROGRESS',
      'FAIL_DISPUTED',
      'REEVALUATION_REQUESTED',
    ]);
    const cancellable = TRANSITIONS.filter((r) => r.trigger === 'cancel-by-deletion');
    expect(cancellable.map((r) => r.from)).to.have.members(['PENDING', 'HR_ACCEPTED']);
    expect(cancellable.every((r) => r.to === 'CANCELLED')).to.equal(true);
    expect(cancellable.find((r) => r.from === 'HR_ACCEPTED')?.quota).to.equal('RELEASE');
    for (const status of DELETION_BLOCKING_STATUSES) {
      expect(findTransition(status, 'cancel-by-deletion', 'SYSTEM'), status).to.equal(undefined);
    }
  });

  it('นักศึกษาถอนใน IN_PROGRESS ไม่ได้ (ต้องขอยุติ)', () => {
    expect(findTransition('IN_PROGRESS', 'withdraw', 'STUDENT')).to.equal(undefined);
    expect(findTransition('IN_PROGRESS', 'request-termination', 'STUDENT')?.to).to.equal('TERMINATED');
  });
});
