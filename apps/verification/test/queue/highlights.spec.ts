import { expect } from 'chai';
import { buildHighlights } from '../../src/queue/highlights';

describe('buildHighlights', () => {
  it('map {term,field,negated,start,end} → {field,start,end,keyword,negated}', () => {
    expect(
      buildHighlights([
        { term: 'ค่ามัดจำ', field: 'description', negated: true, start: 5, end: 13 },
        { term: 'mlm', field: 'job_title', negated: false, start: 0, end: 3 },
      ]),
    ).to.deep.equal([
      { field: 'description', start: 5, end: 13, keyword: 'ค่ามัดจำ', negated: true },
      { field: 'job_title', start: 0, end: 3, keyword: 'mlm', negated: false },
    ]);
  });

  it('ไม่มีรายการ → อาร์เรย์ว่าง', () => {
    expect(buildHighlights([])).to.deep.equal([]);
  });
});
