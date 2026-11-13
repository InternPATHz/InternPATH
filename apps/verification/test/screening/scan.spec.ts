import { expect } from 'chai';
import { normalizeText } from '../../src/screening/normalize';
import { findTermMatches } from '../../src/screening/scan';

const CUES = ['ไม่มี', 'ไม่เก็บ', 'ไม่ต้อง', 'ไม่คิด', 'ไม่รับ', 'no', 'not', 'without'];
const TERMS = [{ term: 'ค่ามัดจำ' }, { term: 'ค่าสมัคร' }, { term: 'โอนเงินก่อน' }, { term: 'mlm' }];
const find = (text: string, maxGap = 12) => findTermMatches(text, 'description', TERMS, CUES, maxGap);

describe('findTermMatches', () => {
  it('"ไม่มีค่ามัดจำ" → 1 ผลที่ negated และ start/end ชี้ที่คำ', () => {
    const text = 'ไม่มีค่ามัดจำ';
    const m = find(text);
    expect(m).to.have.length(1);
    expect(m[0]).to.include({ term: 'ค่ามัดจำ', field: 'description', negated: true });
    expect(text.slice(m[0].start, m[0].end)).to.equal('ค่ามัดจำ');
  });

  it('"เก็บค่ามัดจำ" → ไม่ negated', () => {
    expect(find('เก็บค่ามัดจำ')[0].negated).to.equal(false);
  });

  it('"ไม่มีค่าสมัครแต่ต้องโอนเงินก่อน" → ค่าสมัคร negated, โอนเงินก่อน ไม่ negated', () => {
    const m = find('ไม่มีค่าสมัครแต่ต้องโอนเงินก่อน');
    expect(m.find((x) => x.term === 'ค่าสมัคร')!.negated).to.equal(true);
    expect(m.find((x) => x.term === 'โอนเงินก่อน')!.negated).to.equal(false);
  });

  it('ระยะระหว่างท้าย cue ถึงต้นคำ: 12 ยังนับ, 13 ไม่นับ (maxGap=12)', () => {
    expect(find('ไม่มี' + 'ก'.repeat(12) + 'ค่ามัดจำ')[0].negated).to.equal(true);
    expect(find('ไม่มี' + 'ก'.repeat(13) + 'ค่ามัดจำ')[0].negated).to.equal(false);
  });

  it('cue อยู่คนละประโยค (ขึ้นบรรทัดใหม่/จุด/เครื่องหมาย) → ไม่ negated', () => {
    expect(find('ไม่มี\nค่ามัดจำ')[0].negated).to.equal(false);
    expect(find('ไม่มี. ค่ามัดจำ')[0].negated).to.equal(false);
    expect(find('ไม่มี; ค่ามัดจำ')[0].negated).to.equal(false);
  });

  it('ช่องว่างไม่แบ่งประโยค', () => {
    expect(find('ไม่มี ค่ามัดจำ')[0].negated).to.equal(true);
  });

  it('คำเดียวกันปรากฏสองครั้ง (ปฏิเสธครั้งหนึ่ง ไม่ปฏิเสธอีกครั้ง) → 2 ผลแยกกัน', () => {
    const m = find('ไม่มีค่ามัดจำ\nแต่ต้องจ่ายค่ามัดจำ');
    expect(m).to.have.length(2);
    expect(m.map((x) => x.negated)).to.deep.equal([true, false]);
  });

  it('จับไม่สนตัวพิมพ์: "MLM" ตรงกับ term mlm', () => {
    const text = 'สมัคร MLM';
    const m = find(text);
    expect(m).to.have.length(1);
    expect(text.slice(m[0].start, m[0].end).toLowerCase()).to.equal('mlm');
  });

  it('cue ภาษาอังกฤษต้องเป็นคำเต็ม: "casino mlm" ไม่ถือว่าปฏิเสธ แต่ "no mlm" ถือ', () => {
    expect(find('casino mlm')[0].negated).to.equal(false);
    expect(find('no mlm')[0].negated).to.equal(true);
    expect(find('this is not mlm')[0].negated).to.equal(true);
  });

  it('ออฟเซ็ตใช้ได้กับข้อความที่ผ่าน normalizeText แล้ว (มีอักขระความกว้างศูนย์คั่น)', () => {
    const text = normalizeText('ไม​่มี ค่า​มัดจำ');
    expect(text).to.equal('ไม่มี ค่ามัดจำ');
    const m = find(text);
    expect(m).to.have.length(1);
    expect(text.slice(m[0].start, m[0].end).toLowerCase()).to.equal('ค่ามัดจำ');
    expect(m[0].negated).to.equal(true);
  });

  it('จำกัดจำนวนผลต่อคำ แต่ต้องเหลือทั้งแบบปฏิเสธและไม่ปฏิเสธเสมอ (กัน "ปฏิเสธ 100 ครั้งแล้วซ่อนคำจริงท้ายสุด")', () => {
    const text = 'ไม่มีค่ามัดจำ\n'.repeat(1000) + 'ต้องจ่ายค่ามัดจำ';
    const m = find(text);
    expect(m.length).to.be.at.most(200);
    expect(m.some((x) => !x.negated)).to.equal(true);
    expect(m.some((x) => x.negated)).to.equal(true);
    const many = findTermMatches('ก'.repeat(200_000), 'description', [{ term: 'ก' }], CUES, 12);
    expect(many.length).to.be.at.most(200);
  });

  it('ไม่เจอ term → อาร์เรย์ว่าง', () => {
    expect(find('งานดีมาก')).to.deep.equal([]);
  });

  it('ข้อความ 200,000 ตัวอักษร (ไม่มีคำ / มีคำซ้ำจำนวนมาก) จบภายใน 1 วินาที', () => {
    const t0 = Date.now();
    find('ก'.repeat(200_000));
    find('ไม่มีค่ามัดจำ'.repeat(15_000));
    find('เก็บค่ามัดจำ'.repeat(16_000));
    expect(Date.now() - t0).to.be.lessThan(1000);
  });
});
