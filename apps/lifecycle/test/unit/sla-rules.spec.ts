import { expect } from 'chai';
import type { ApplicationStatus } from '@internpath/contracts';
import { LIFECYCLE_DEFAULTS } from '../../src/config/lifecycle.constants';
import {
  ADMIN_ESCALATION_TYPES,
  SLA_CONFIG_KEYS,
  bangkokStartOfDay,
  decideSla,
  type SlaApplication,
  type SlaConfig,
} from '../../src/jobs/sla-rules';
import type { SchedulerRegistry } from '@nestjs/schedule';
import type { LifecycleConfigService } from '../../src/config/lifecycle-config.service';
import { SLA_INTERVAL_NAME, SlaSchedulerRunner } from '../../src/jobs/sla-scheduler.module';
import type { SlaSchedulerService } from '../../src/jobs/sla-scheduler.service';
import { addDays, bangkokToday } from '../../src/state-machine/dates';

const DAY_MS = 86_400_000;
const BKK_MS = 7 * 3_600_000;
const config = Object.fromEntries(SLA_CONFIG_KEYS.map((k) => [k, LIFECYCLE_DEFAULTS[k]])) as SlaConfig;

/** 10:00 น. เวลาไทย ของวันที่ 2026-11-18 */
const NOW = new Date(Date.UTC(2026, 10, 18, 3, 0, 0));
const TODAY = bangkokToday(NOW);
const ymd = (d: Date) => d.toISOString().slice(0, 10);

function app(status: ApplicationStatus, data: Partial<SlaApplication> = {}): SlaApplication {
  return {
    status,
    frozen: false,
    slaPausedSeconds: 0,
    statusChangedAt: NOW,
    startDate: null,
    endDate: null,
    actualStartDate: null,
    actualEndDate: null,
    ...data,
  };
}

/** เปลี่ยนสถานะเมื่อ `days` วันก่อน (เวลาเดียวกันของวัน) */
const changed = (days: number) => new Date(NOW.getTime() - days * DAY_MS);

/** ผลการตัดสินแบบอ่านง่าย: `EXPIRE` / ชื่อ reminder_type / `NONE` */
function verdict(a: SlaApplication, facts = {}, now = NOW): string {
  const d = decideSla(a, config, now, facts);
  return d.kind === 'REMIND' ? d.milestone.type : d.kind;
}

describe('SLA rules (Unit) — README §5.3', () => {
  it('PENDING: เตือน HR วัน 3 และ 7, EXPIRED วัน 14', () => {
    const at = (days: number) => verdict(app('PENDING', { statusChangedAt: changed(days) }));
    expect([0, 2, 3, 6, 7, 13, 14, 30].map(at)).to.deep.equal([
      'NONE',
      'NONE',
      'HR_RESPOND_PENDING_D3',
      'HR_RESPOND_PENDING_D3',
      'HR_RESPOND_PENDING_D7',
      'HR_RESPOND_PENDING_D7',
      'EXPIRE',
      'EXPIRE',
    ]);
  });

  it('HR_ACCEPTED: เตือนนักศึกษาวัน 3, EXPIRED วัน 5', () => {
    const at = (days: number) => verdict(app('HR_ACCEPTED', { statusChangedAt: changed(days) }));
    expect([2, 3, 4, 5].map(at)).to.deep.equal(['NONE', 'STUDENT_CONFIRM_D3', 'STUDENT_CONFIRM_D3', 'EXPIRE']);
  });

  it('ADVISOR_PENDING: เตือนอาจารย์วัน 3, แจ้ง Admin วัน 7 — ไม่หมดอายุ/ไม่อนุมัติอัตโนมัติ', () => {
    const at = (days: number) => verdict(app('ADVISOR_PENDING', { statusChangedAt: changed(days) }));
    expect([3, 7, 60].map(at)).to.deep.equal(['ADVISOR_APPROVE_D3', 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7', 'ADVISOR_APPROVE_ESCALATE_ADMIN_D7']);
  });

  it('ADVISOR_APPROVED: นับจาก start_date — วันนั้น, +3, เกิน 7 วันแจ้งอาจารย์/Admin, เกิน 14 วัน EXPIRED', () => {
    const at = (days: number) => verdict(app('ADVISOR_APPROVED', { startDate: addDays(TODAY, -days) }));
    expect([-1, 0, 3, 7, 8, 14, 15].map(at)).to.deep.equal([
      'NONE',
      'HR_START_CONFIRM_ON_START',
      'HR_START_CONFIRM_D3',
      'HR_START_CONFIRM_D3',
      'START_CONFIRM_ESCALATE_D7',
      'START_CONFIRM_ESCALATE_D7',
      'EXPIRE',
    ]);
    expect(verdict(app('ADVISOR_APPROVED'))).to.equal('NONE'); // ยังไม่มี start_date
  });

  it('รอประเมิน: IN_PROGRESS (end_date), TERMINATED ฝึกจริง ≥ 30 วัน (actual_end_date), REEVALUATION_REQUESTED — วัน 3 และ 14', () => {
    const inProgress = (days: number) => verdict(app('IN_PROGRESS', { endDate: addDays(TODAY, -days) }));
    expect([-5, 0, 3, 13, 14].map(inProgress)).to.deep.equal([
      'NONE',
      'NONE',
      'HR_EVALUATE_D3',
      'HR_EVALUATE_D3',
      'EVALUATE_ESCALATE_D14',
    ]);
    const terminated = (actual: number) =>
      verdict(
        app('TERMINATED', { actualStartDate: addDays(TODAY, -3 - actual), actualEndDate: addDays(TODAY, -3) }),
      );
    expect(terminated(30)).to.equal('HR_EVALUATE_D3');
    expect(terminated(29)).to.equal('NONE'); // ไม่มีการประเมิน — อาจารย์ตัดสินผลเอง
    expect(verdict(app('REEVALUATION_REQUESTED', { statusChangedAt: changed(14) }))).to.equal('EVALUATE_ESCALATE_D14');
  });

  it('EVALUATED_PASS: เตือนออกใบวัน 3, แจ้ง Admin วัน 14 — เฉพาะฝึกจริงครบเกณฑ์และยังไม่มีใบ', () => {
    const passed = (days: number, actual = 60) =>
      app('EVALUATED_PASS', {
        statusChangedAt: changed(days),
        actualStartDate: addDays(TODAY, -days - actual),
        actualEndDate: addDays(TODAY, -days),
      });
    expect(verdict(passed(3))).to.equal('HR_ISSUE_CERT_D3');
    expect(verdict(passed(14))).to.equal('ISSUE_CERT_ESCALATE_D14');
    expect(verdict(passed(14), { hasCertificate: true })).to.equal('NONE');
    expect(verdict(passed(14, 20))).to.equal('NONE');
  });

  it('FAIL_DISPUTED: เตือนอาจารย์วัน 3, แจ้ง Admin วัน 7 • สถานะอื่น ⇒ ไม่ทำอะไร', () => {
    expect(verdict(app('FAIL_DISPUTED', { statusChangedAt: changed(3) }))).to.equal('ADVISOR_DISPUTE_D3');
    expect(verdict(app('FAIL_DISPUTED', { statusChangedAt: changed(7) }))).to.equal('DISPUTE_ESCALATE_D7');
    for (const s of ['COMPLETED', 'EXPIRED', 'EVALUATED_FAIL', 'NO_EVALUATION', 'WITHDRAWN'] as ApplicationStatus[]) {
      expect(verdict(app(s, { statusChangedAt: changed(100), endDate: addDays(TODAY, -100) })), s).to.equal('NONE');
    }
  });

  it('due_date = วันฐาน + วันของขั้น (ไม่ขึ้นกับวันที่รัน) และนับวันตามเวลาไทย', () => {
    // เปลี่ยนสถานะ 23:30 น. เวลาไทย ⇒ วันฐานคือวันนั้นตามเวลาไทย (UTC ยังเป็น 16:30 วันเดียวกัน)
    const base = addDays(TODAY, -5);
    const changedAt = new Date(base.getTime() - BKK_MS + 23.5 * 3_600_000);
    const d = decideSla(app('PENDING', { statusChangedAt: changedAt }), config, NOW);
    expect(d.kind).to.equal('REMIND');
    if (d.kind !== 'REMIND') return;
    expect(ymd(d.dueDate)).to.equal(ymd(addDays(base, 3)));
    expect(d.elapsedDays).to.equal(5);
    expect(ymd(d.deadline as Date)).to.equal(ymd(addDays(base, 14)));

    // 00:30 น. เวลาไทยของวันถัดไป = UTC ยังเป็นวันก่อน — ต้องนับเป็นวันใหม่ตามเวลาไทย
    const justAfterMidnight = new Date(addDays(TODAY, -3).getTime() - BKK_MS + 30 * 60_000);
    expect(verdict(app('PENDING', { statusChangedAt: justAfterMidnight }))).to.equal('HR_RESPOND_PENDING_D3');
    const justBeforeMidnight = new Date(addDays(TODAY, -2).getTime() - BKK_MS - 30 * 60_000);
    expect(verdict(app('PENDING', { statusChangedAt: justBeforeMidnight }))).to.equal('HR_RESPOND_PENDING_D3');
  });

  it('Freeze: ใบที่กำลัง frozen หยุดนับ • sla_paused_seconds เลื่อนการนับแต่ due_date คงเดิม', () => {
    expect(verdict(app('PENDING', { statusChangedAt: changed(30), frozen: true }))).to.equal('NONE');
    // สมัคร 16 วันก่อน แต่ถูก Freeze ไป 5 วัน ⇒ นับได้ 11 วัน (ยังไม่ EXPIRED) และขั้นล่าสุด = D7
    const paused = app('PENDING', { statusChangedAt: changed(16), slaPausedSeconds: 5 * 86_400 });
    const d = decideSla(paused, config, NOW);
    expect(d.kind === 'REMIND' && d.milestone.type).to.equal('HR_RESPOND_PENDING_D7');
    if (d.kind === 'REMIND') {
      expect(d.elapsedDays).to.equal(11);
      expect(ymd(d.dueDate)).to.equal(ymd(addDays(TODAY, -16 + 7)));
    }
    expect(verdict(app('PENDING', { statusChangedAt: changed(19), slaPausedSeconds: 5 * 86_400 }))).to.equal('EXPIRE');
  });

  it('ค่า SLA มาจาก config (config_overrides เร่งเวลาทดสอบได้)', () => {
    const fast = { ...config, SLA_PENDING_REMINDER_D3: 0, SLA_PENDING_REMINDER_D7: 1, SLA_PENDING_DAYS: 2 };
    const at = (days: number) => {
      const d = decideSla(app('PENDING', { statusChangedAt: changed(days) }), fast, NOW);
      return d.kind === 'REMIND' ? d.milestone.type : d.kind;
    };
    expect([0, 1, 2].map(at)).to.deep.equal(['HR_RESPOND_PENDING_D3', 'HR_RESPOND_PENDING_D7', 'EXPIRE']);
  });

  it('ขั้นยกระดับที่ต้องมี Admin ไม่ใส่ Admin ใน audience เอง (Notification เติม) และใช้เฉพาะ reminder_type ของ E14', () => {
    const escalations = [
      app('ADVISOR_PENDING', { statusChangedAt: changed(7) }),
      app('ADVISOR_APPROVED', { startDate: addDays(TODAY, -8) }),
      app('IN_PROGRESS', { endDate: addDays(TODAY, -14) }),
      app('FAIL_DISPUTED', { statusChangedAt: changed(7) }),
    ];
    for (const a of escalations) {
      const d = decideSla(a, config, NOW);
      expect(d.kind).to.equal('REMIND');
      if (d.kind === 'REMIND') {
        expect(ADMIN_ESCALATION_TYPES).to.include(d.milestone.type);
        expect(d.milestone.audience).to.not.include('PLATFORM_ADMIN');
      }
    }
    expect(bangkokStartOfDay(TODAY)).to.equal(new Date(TODAY.getTime() - BKK_MS).toISOString());
  });
});

describe('SlaSchedulerRunner (Unit)', () => {
  const makeRunner = (runOnce: () => Promise<unknown>) => {
    const registered: string[] = [];
    const runner = new SlaSchedulerRunner(
      { runOnce } as unknown as SlaSchedulerService,
      { getNumber: async () => 15 } as unknown as LifecycleConfigService,
      { addInterval: (name: string, handle: NodeJS.Timeout) => { registered.push(name); clearInterval(handle); } } as unknown as SchedulerRegistry,
    );
    return { runner, registered };
  };

  it('ลงทะเบียน interval ตอนบูต • รอบที่ยังไม่จบไม่ถูกเริ่มซ้อน • error ไม่หลุดออกจาก tick', async () => {
    let calls = 0;
    let release!: () => void;
    const { runner, registered } = makeRunner(() => {
      calls += 1;
      return new Promise<void>((resolve) => (release = resolve));
    });
    await runner.onApplicationBootstrap();
    expect(registered).to.deep.equal([SLA_INTERVAL_NAME]);

    const first = runner.tick();
    await runner.tick(); // ซ้อน ⇒ ข้าม
    expect(calls).to.equal(1);
    release();
    await first;

    const failing = makeRunner(async () => {
      throw new Error('db down');
    });
    await failing.runner.tick(); // ไม่ throw
  });
});
