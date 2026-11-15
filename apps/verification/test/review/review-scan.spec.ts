import { expect } from 'chai';
import { REVIEW_FIELD, reviewText, scanReview } from '../../src/review/review-scan';
import { DEFAULT_RULES } from '../../src/screening/defaults';
import { normalizeText } from '../../src/screening/normalize';

const scan = (title: string | null, body: string) => scanReview(normalizeText(reviewText(title, body)), DEFAULT_RULES);

describe('scanReview — ตัวสแกนรีวิว (สไลซ์ 3 §5.3)', () => {
  it('ข้อความสะอาด ⇒ ไม่พัก', () => {
    expect(scan('ประสบการณ์ดี', 'พี่เลี้ยงใจดี งานท้าทาย ได้เรียนรู้เยอะ')).to.deep.include({ hold: false, reasons: [] });
  });

  it('คำ HARD ที่ไม่ถูกปฏิเสธ ⇒ HOLD + BLACKLIST และ matched ใช้ field "review"', () => {
    const r = scan(null, 'บริษัทเรียกเก็บค่ามัดจำก่อนเริ่มงาน');
    expect(r.hold).to.equal(true);
    expect(r.reasons).to.deep.equal([{ code: 'BLACKLIST' }]);
    expect(r.matched.length).to.be.greaterThan(0);
    for (const m of r.matched) expect(m.field).to.equal(REVIEW_FIELD);
  });

  it('เบอร์โทร / อีเมล / LINE ID ⇒ HOLD + PERSONAL_CONTACT', () => {
    for (const body of ['ติดต่อพี่ได้ที่ 081-234-5678', 'อีเมล someone@example.com', 'line id: abc12345']) {
      const r = scan(null, body);
      expect(r.hold, body).to.equal(true);
      expect(r.reasons, body).to.deep.equal([{ code: 'PERSONAL_CONTACT' }]);
    }
  });

  it('ทั้งคำต้องห้ามและข้อมูลติดต่อ ⇒ สองเหตุผล เรียง BLACKLIST ก่อน', () => {
    const r = scan(null, 'เรียกค่าสมัคร โทร 081-234-5678');
    expect(r.reasons).to.deep.equal([{ code: 'BLACKLIST' }, { code: 'PERSONAL_CONTACT' }]);
  });

  it('ประโยคปฏิเสธที่มีคำ HARD ⇒ ไม่พัก (matched ยังคืน negated=true เพื่อทำ highlight)', () => {
    const r = scan(null, 'ไม่เก็บค่ามัดจำเลย');
    expect(r.hold).to.equal(false);
    expect(r.reasons).to.deep.equal([]);
    expect(r.matched.some((m) => m.negated)).to.equal(true);
  });

  it('คำ SOFT อย่างเดียว ⇒ ไม่พัก', () => {
    expect(scan(null, 'งานด่วน รับทันที รายได้ดี ที่นั่งจำกัด').hold).to.equal(false);
  });

  it('ข้อมูลติดต่ออยู่ใน title อย่างเดียว ⇒ HOLD (Review Focus ข้อ 3)', () => {
    expect(scan('ติดต่อ 081-234-5678', 'ดีมาก').hold).to.equal(true);
  });

  it('reviewText: title ว่าง/ไม่มี ⇒ body ล้วน; มี title ⇒ ต่อด้วยบรรทัดใหม่', () => {
    expect(reviewText(null, 'x')).to.equal('x');
    expect(reviewText(undefined, 'x')).to.equal('x');
    expect(reviewText('', 'x')).to.equal('x');
    expect(reviewText('t', 'x')).to.equal('t\nx');
  });
});
