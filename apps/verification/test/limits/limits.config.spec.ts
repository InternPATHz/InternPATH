import { expect } from 'chai';
import { limitsFromConfig } from '../../src/limits/limits.config';

describe('limitsFromConfig', () => {
  const none = () => undefined;

  it('ไม่มี env ⇒ ค่าตั้งต้น 3/5/3/3/30', () => {
    expect(limitsFromConfig(none)).to.deep.equal({
      reportThreshold: 3,
      reportDailyLimit: 5,
      reporterDismissStreak: 3,
      rejectionThreshold: 3,
      rejectionWindowDays: 30,
    });
  });

  it('REPORT_THRESHOLD=5 ⇒ reportThreshold=5 และค่าอื่นคงเดิม', () => {
    const c = limitsFromConfig((k: string) => (k === 'REPORT_THRESHOLD' ? '5' : undefined));
    expect(c.reportThreshold).to.equal(5);
    expect(c.reportDailyLimit).to.equal(5);
  });

  it('ค่าที่ไม่ใช่จำนวนเต็มบวก (abc, 0, -1, 2.5) ⇒ ใช้ค่าตั้งต้น', () => {
    for (const bad of ['abc', '0', '-1', '2.5']) {
      expect(limitsFromConfig(() => bad).rejectionWindowDays, bad).to.equal(30);
    }
  });
});
