import { expect } from 'chai';
import { computeDueAt, isOverdue, type SlaConfig } from '../../src/queue/sla';

const CFG: SlaConfig = { normalHours: 48, fastHours: 12 };
const HOUR = 3600_000;

describe('queue SLA', () => {
  const created = new Date('2026-11-13T00:00:00.000Z');

  it('computeDueAt: NORMAL = +48 ชม., FAST_TRACK = +12 ชม. (ชั่วโมงจริง)', () => {
    expect(computeDueAt(created, 'NORMAL', CFG).getTime() - created.getTime()).to.equal(48 * HOUR);
    expect(computeDueAt(created, 'FAST_TRACK', CFG).getTime() - created.getTime()).to.equal(12 * HOUR);
  });

  it('computeDueAt ใช้ค่าจาก config', () => {
    expect(computeDueAt(created, 'NORMAL', { normalHours: 1, fastHours: 1 }).getTime() - created.getTime()).to.equal(HOUR);
  });

  it('isOverdue: เกิน due_at และยังไม่ RESOLVED → true; RESOLVED → false; ก่อนถึง → false; พอดี due_at → false', () => {
    const dueAt = new Date('2026-11-15T00:00:00.000Z');
    const after = new Date(dueAt.getTime() + 1);
    expect(isOverdue({ status: 'OPEN', dueAt }, after)).to.equal(true);
    expect(isOverdue({ status: 'IN_REVIEW', dueAt }, after)).to.equal(true);
    expect(isOverdue({ status: 'RESOLVED', dueAt }, after)).to.equal(false);
    expect(isOverdue({ status: 'OPEN', dueAt }, new Date(dueAt.getTime() - 1))).to.equal(false);
    expect(isOverdue({ status: 'OPEN', dueAt }, dueAt)).to.equal(false);
  });
});
