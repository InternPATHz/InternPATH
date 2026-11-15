import { expect } from 'chai';
import { detectContact } from '../../src/screening/contact';
import { DEFAULT_RULES } from '../../src/screening/defaults';
import { normalizeText } from '../../src/screening/normalize';
import { findTermMatches } from '../../src/screening/scan';

/** Minor สไลซ์ 1 — กันการหลบแบบง่าย (แบบ B ที่ PM เลือก 2026-11-15): ไม่จับคำที่มีตัวคั่นแทรกระหว่างตัวอักษร */
const hard = DEFAULT_RULES.blacklist.filter((t) => t.severity === 'HARD');
const terms = (s: string) => findTermMatches(normalizeText(s), 'f', hard, DEFAULT_RULES.negationCues, 12).filter((m) => !m.negated);
const kinds = (s: string) => detectContact(normalizeText(s)).map((m) => m.kind);

describe('ตัวสแกน: กันการหลบแบบง่าย (Minor สไลซ์ 1, แบบ B)', () => {
  it('ตัวอักษรเต็มความกว้าง (full-width) ⇒ จับคำต้องห้ามได้ และ start/end ชี้ที่ข้อความเดิม', () => {
    const text = 'งานนี้เป็น ＭＬＭ ชัดเจน';
    const m = terms(text);
    expect(m).to.have.length(1);
    expect(normalizeText(text).slice(m[0].start, m[0].end)).to.equal('ＭＬＭ');
  });

  it('เบอร์โทรเขียนด้วยเลขไทย / เลขเต็มความกว้าง ⇒ PHONE และ matched ชี้ที่ข้อความเดิม', () => {
    for (const s of ['โทร ๐๘๑-๒๓๔-๕๖๗๘', 'โทร ０８１-２３４-５６７８', 'โทร ๐๘๑๒๓๔๕๖๗๘']) {
      const found = detectContact(normalizeText(s));
      expect(found.map((x) => x.kind), s).to.include('PHONE');
      const phone = found.find((x) => x.kind === 'PHONE')!;
      expect(normalizeText(s).slice(phone.start, phone.end), s).to.equal(phone.matched);
    }
  });

  it('เบอร์โทรคั่นด้วยจุด หรือจัดกลุ่มแบบอื่น ⇒ PHONE', () => {
    for (const s of ['โทร 081.234.5678', 'โทร 08-1234-5678', 'โทร 0812-345-678', 'โทร 02.123.4567', 'โทร +66.81.234.5678']) {
      expect(kinds(s), s).to.include('PHONE');
    }
  });

  it('อีเมลแบบ [at] / (at) / [dot] ⇒ EMAIL', () => {
    for (const s of ['ส่งมาที่ hr [at] example [dot] com', 'hr(at)example.com', 'hr [at] example.co.th', 'HR (AT) EXAMPLE (DOT) COM']) {
      expect(kinds(s), s).to.include('EMAIL');
    }
  });

  it('"ไลน์ไอดี xxx" ⇒ LINE', () => {
    expect(kinds('ไลน์ไอดี abc123')).to.include('LINE');
    expect(kinds('ไลน์ไอดี: abc123')).to.include('LINE');
  });

  it('ยังไม่จับ (นอกขอบเขตแบบ B): คำที่มีตัวคั่นแทรกระหว่างตัวอักษร', () => {
    for (const s of ['เก็บค่า มัดจำ', 'M L M', 'm.l.m']) expect(terms(s), s).to.deep.equal([]);
  });

  it('ไม่จับข้อความปกติที่หน้าตาคล้ายเบอร์/อีเมล (กัน false positive)', () => {
    for (const s of [
      'เวลาทำงาน 08.30-17.30 น.',
      'เวลา 09.00-18.00 น. วันที่ 06-11-2569',
      'เงินเดือน 8,000.50 บาท',
      'ปีการศึกษา ๒๕๖๙ ภาคเรียนที่ ๑',
      'เวอร์ชัน 1.2.3 และ 10.0.1',
      'ทำงาน ๘ ชั่วโมง/วัน',
      'meet at the office (at 9am)',
      'Line Manager ดูแลโดยตรง',
      'ไลน์การผลิตของโรงงาน',
    ]) {
      expect(detectContact(normalizeText(s)), s).to.deep.equal([]);
    }
  });
});
