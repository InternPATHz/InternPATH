import { randomUUID } from 'node:crypto';
import type { InternalJobResponse, InternalStudentResponse } from '@internpath/contracts';
import { expect } from 'chai';
import { buildApplicationStatusChanged } from '../../../src/events/producers/application-status-changed';
import {
  assertJobOpen,
  blockedReasonError,
  computeMajorMismatch,
  isDeadlinePassed,
  studentBlockedReason,
} from '../../../src/modules/applications/apply-rules';

// 2026-11-18 23:30 เวลากรุงเทพ = 16:30 UTC
const NOW = new Date('2026-11-18T16:30:00Z');

const job = (data: Partial<InternalJobResponse> = {}): InternalJobResponse => ({
  job_id: randomUUID(),
  company_id: randomUUID(),
  status: 'PUBLISHED',
  quota: 2,
  quota_available: 2,
  target_majors: [],
  application_deadline: '2026-12-31',
  entity_version: 1,
  ...data,
});

const student = (data: Partial<InternalStudentResponse> = {}): InternalStudentResponse => ({
  major: 'วิศวกรรมคอมพิวเตอร์',
  year_level: 3,
  university_id: randomUUID(),
  email_verified: true,
  advisor_id: randomUUID(),
  advisor_link_status: 'LINKED',
  ...data,
});

const codeOf = (fn: () => void): { code?: string; issue?: string } => {
  try {
    fn();
    return {};
  } catch (error) {
    const e = error as { code?: string; details?: Array<{ issue?: string }> };
    return { code: e.code, issue: e.details?.[0]?.issue };
  }
};

describe('1.4 apply-rules (Unit)', () => {
  describe('isDeadlinePassed — นับตามวันกรุงเทพ รวมวัน deadline', () => {
    it('วันเดียวกัน (เวลาไทย) ยังสมัครได้ แม้ UTC ยังเป็นวันก่อน/หลัง', () => {
      expect(isDeadlinePassed('2026-11-18', NOW)).to.equal(false);
      // 00:30 ไทยของวันที่ 19 = 17:30 UTC ของวันที่ 18 ⇒ เลย deadline 18 แล้ว
      expect(isDeadlinePassed('2026-11-18', new Date('2026-11-18T17:30:00Z'))).to.equal(true);
    });

    it('รับ ISO เต็ม (ใช้ส่วนวันที่) • ไม่มี/อ่านไม่ออก ⇒ ถือว่าเลย (fail-closed)', () => {
      expect(isDeadlinePassed('2026-11-19T00:00:00.000Z', NOW)).to.equal(false);
      expect(isDeadlinePassed('2026-11-17', NOW)).to.equal(true);
      expect(isDeadlinePassed('', NOW)).to.equal(true);
      expect(isDeadlinePassed(null, NOW)).to.equal(true);
      expect(isDeadlinePassed('31/12/2026', NOW)).to.equal(true);
    });
  });

  describe('assertJobOpen', () => {
    it('PUBLISHED และยังไม่เลย deadline ⇒ ผ่าน', () => {
      expect(codeOf(() => assertJobOpen(job(), NOW))).to.deep.equal({});
    });

    it('CLOSED / สถานะอื่น / เลย deadline ⇒ 409 STATE_CONFLICT + issue', () => {
      expect(codeOf(() => assertJobOpen(job({ status: 'CLOSED' }), NOW))).to.deep.equal({ code: 'STATE_CONFLICT', issue: 'JOB_CLOSED' });
      for (const status of ['DRAFT', 'VERIFYING', 'PENDING_REVIEW', 'SUSPENDED', 'REMOVED', 'AUTO_REJECTED'] as const) {
        expect(codeOf(() => assertJobOpen(job({ status }), NOW)).issue, status).to.equal('JOB_NOT_PUBLISHED');
      }
      expect(codeOf(() => assertJobOpen(job({ application_deadline: '2026-11-01' }), NOW)).issue).to.equal('DEADLINE_PASSED');
    });
  });

  describe('computeMajorMismatch', () => {
    it('ไม่ระบุสาขา ⇒ false • อยู่ในรายการ (ไม่สนช่องว่าง/ตัวพิมพ์) ⇒ false • ไม่อยู่ ⇒ true', () => {
      expect(computeMajorMismatch('Computer Engineering', [])).to.equal(false);
      expect(computeMajorMismatch('Computer Engineering', null)).to.equal(false);
      expect(computeMajorMismatch('Computer Engineering', ['  ', ''])).to.equal(false);
      expect(computeMajorMismatch(' computer  engineering ', ['Computer Engineering'])).to.equal(false);
      expect(computeMajorMismatch('วิศวกรรมคอมพิวเตอร์', ['บัญชี', 'วิศวกรรมคอมพิวเตอร์'])).to.equal(false);
      expect(computeMajorMismatch('วิศวกรรมคอมพิวเตอร์', ['บัญชี'])).to.equal(true);
    });
  });

  describe('studentBlockedReason / blockedReasonError', () => {
    it('อีเมลก่อน แล้วจึงอาจารย์ (ต้อง LINKED และมี advisor_id)', () => {
      expect(studentBlockedReason(student())).to.equal(null);
      expect(studentBlockedReason(student({ email_verified: false, advisor_link_status: 'NONE' }))).to.equal('EMAIL_NOT_VERIFIED');
      expect(studentBlockedReason(student({ advisor_link_status: 'ADVISOR_LINK_PENDING' }))).to.equal('ADVISOR_NOT_LINKED');
      expect(studentBlockedReason(student({ advisor_id: undefined }))).to.equal('ADVISOR_NOT_LINKED');
    });

    it('แปลงเป็น code/HTTP ตาม api-contract §2', () => {
      const toPair = (e: { code: string; getStatus(): number }) => [e.code, e.getStatus()];
      expect(toPair(blockedReasonError('EMAIL_NOT_VERIFIED'))).to.deep.equal(['EMAIL_NOT_VERIFIED', 401]);
      expect(toPair(blockedReasonError('ADVISOR_NOT_LINKED'))).to.deep.equal(['ADVISOR_NOT_LINKED', 403]);
      expect(toPair(blockedReasonError('REAPPLY_BLOCKED'))).to.deep.equal(['REAPPLY_BLOCKED', 403]);
    });
  });

  describe('buildApplicationStatusChanged — สร้างใบสมัคร', () => {
    it('fromStatus = null ⇒ ไม่มีคีย์ from_status (PM ตัดสิน 2026-11-18)', () => {
      const payload = buildApplicationStatusChanged(
        {
          id: randomUUID(),
          jobId: randomUUID(),
          companyId: randomUUID(),
          studentUserId: randomUUID(),
          advisorUserId: randomUUID(),
          status: 'PENDING',
          terminatedBy: null,
          entityVersion: 1,
        },
        null,
        { userId: randomUUID(), role: 'STUDENT' },
        NOW,
      );
      expect(payload).to.not.have.property('from_status');
      expect(payload.to_status).to.equal('PENDING');
      expect(payload.changed_at).to.equal(NOW.toISOString());
    });
  });
});
