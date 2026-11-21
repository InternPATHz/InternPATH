import { expect } from 'chai';
import { QUEUE_ITEM_DETAIL, REPORT_CREATED_RESPONSE, SET_COMPANY_FLAG_RESPONSE, expectShape } from '../support/contract-shapes';

describe('expectShape (ตัวตรวจรูปร่าง response เทียบ contracts)', () => {
  it('ผ่านเมื่อคีย์และชนิดตรง', () => {
    expectShape({ id: 'a', status: 'OPEN' }, REPORT_CREATED_RESPONSE);
    expectShape({ company_id: 'c', active: true, changed: false }, SET_COMPANY_FLAG_RESPONSE);
  });

  it('ล้มเมื่อมีคีย์เกิน, ขาดคีย์, หรือชนิดผิด', () => {
    expect(() => expectShape({ id: 'a', status: 'OPEN', extra: 1 }, REPORT_CREATED_RESPONSE)).to.throw(/ไม่รู้จัก/);
    expect(() => expectShape({ id: 'a' }, REPORT_CREATED_RESPONSE)).to.throw(/ขาดคีย์ status/);
    expect(() => expectShape({ id: 1, status: 'OPEN' }, REPORT_CREATED_RESPONSE)).to.throw(/ชนิดจริง number/);
    expect(() => expectShape(null, REPORT_CREATED_RESPONSE)).to.throw();
  });

  it('QUEUE_ITEM_DETAIL บังคับฟิลด์รีวิว (review, review_reports) และเนื้อหาประกาศ (content)', () => {
    const keys = Object.keys(QUEUE_ITEM_DETAIL);
    expect(keys).to.include.members(['review', 'review_reports', 'reports', 'content']);
    expect(keys).to.not.include.members(['highlights', 'risk_score', 'appeal_statement']);
  });
});
