import { expect } from 'chai';
import { APPEAL_RESPONSE, QUEUE_ITEM_DETAIL, VERIFICATION_RESULT, expectShape } from '../support/contract-shapes';

describe('expectShape (ตัวตรวจรูปร่าง response เทียบ contracts)', () => {
  it('ผ่านเมื่อคีย์และชนิดตรง; คีย์ optional (admin_reason) ไม่มีได้', () => {
    expectShape({ id: 'a', status: 'OPEN' }, APPEAL_RESPONSE);
    const base = { risk_level: 'HIGH', risk_score: 80, reasons: [], matched_keywords: [], is_appeal: false, can_appeal: true };
    expectShape(base, VERIFICATION_RESULT);
    expectShape({ ...base, admin_reason: 'เหตุผล' }, VERIFICATION_RESULT);
  });

  it('ล้มเมื่อมีคีย์เกิน, ขาดคีย์, หรือชนิดผิด', () => {
    expect(() => expectShape({ id: 'a', status: 'OPEN', extra: 1 }, APPEAL_RESPONSE)).to.throw(/ไม่รู้จัก/);
    expect(() => expectShape({ id: 'a' }, APPEAL_RESPONSE)).to.throw(/ขาดคีย์ status/);
    expect(() => expectShape({ id: 1, status: 'OPEN' }, APPEAL_RESPONSE)).to.throw(/ชนิดจริง number/);
    expect(() => expectShape(null, APPEAL_RESPONSE)).to.throw();
  });

  it('QUEUE_ITEM_DETAIL บังคับฟิลด์รีวิวของสไลซ์ 3 (review, review_reports)', () => {
    const keys = Object.keys(QUEUE_ITEM_DETAIL);
    expect(keys).to.include.members(['review', 'review_reports', 'reports', 'highlights']);
  });
});
