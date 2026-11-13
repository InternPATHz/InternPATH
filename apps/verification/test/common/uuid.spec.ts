import { randomUUID } from 'node:crypto';
import { expect } from 'chai';
import { asUuid } from '../../src/common/uuid';

describe('asUuid', () => {
  it('คืนค่าเดิมเมื่อเป็น UUID', () => {
    const id = randomUUID();
    expect(asUuid(id)).to.equal(id);
    expect(asUuid(id.toUpperCase())).to.equal(id.toUpperCase());
  });

  it("ค่าที่ไม่ใช่ UUID ('abc-123') หรือ undefined → UUID ใหม่ที่ไม่เท่าเดิม", () => {
    const a = asUuid('abc-123');
    expect(a).to.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(a).to.not.equal('abc-123');
    expect(asUuid(undefined)).to.match(/^[0-9a-f-]{36}$/);
  });
});
