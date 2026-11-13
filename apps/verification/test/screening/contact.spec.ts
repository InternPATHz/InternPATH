import { expect } from 'chai';
import { detectContact } from '../../src/screening/contact';

const kinds = (s: string) => detectContact(s).map((m) => m.kind);

describe('detectContact', () => {
  it('เบอร์โทรไทย → PHONE', () => {
    expect(kinds('โทร 081-234-5678 ได้เลย')).to.include('PHONE');
    expect(kinds('โทร 0812345678')).to.include('PHONE');
    expect(kinds('โทร +66 81 234 5678')).to.include('PHONE');
    expect(kinds('โทรศัพท์ 02-123-4567')).to.include('PHONE');
  });

  it('อีเมล → EMAIL', () => {
    expect(kinds('ส่งมาที่ hr@example.co.th')).to.include('EMAIL');
  });

  it('LINE ID → LINE', () => {
    expect(kinds('line id: abc123')).to.include('LINE');
    expect(kinds('LINE ID abc123')).to.include('LINE');
    expect(kinds('ไลน์ @abc123')).to.include('LINE');
    expect(kinds('ไอดีไลน์ abc123')).to.include('LINE');
    expect(kinds('ทักมาที่ @company_hr')).to.include('LINE');
  });

  it('ลิงก์ messenger/social → SOCIAL_LINK', () => {
    expect(kinds('https://line.me/ti/p/xyz')).to.include('SOCIAL_LINK');
    expect(kinds('t.me/somebody')).to.include('SOCIAL_LINK');
    expect(kinds('facebook.com/company')).to.include('SOCIAL_LINK');
    expect(kinds('wa.me/66812345678')).to.include('SOCIAL_LINK');
  });

  it('ต้องไม่จับตัวเลข/ข้อความปกติเป็นช่องทางติดต่อ', () => {
    for (const s of [
      '5,000-8,000',
      'เบี้ยเลี้ยง 15000 บาท',
      'สัปดาห์ละ 35 ชั่วโมง',
      'เวลาทำงาน 09.00-18.00 น.',
      'ทำงานวันจันทร์ถึงศุกร์ 08:00-17:00',
      'https://company.example/about',
      'online marketing and baseline testing',
      'ติดต่อไลน์ได้ที่แพลตฟอร์ม',
    ]) {
      expect(detectContact(s), s).to.deep.equal([]);
    }
  });

  it('start/end ชี้ที่ข้อความที่จับได้ (ใช้ไฮไลต์ได้)', () => {
    const text = 'โทร 081-234-5678 ครับ';
    const m = detectContact(text).find((x) => x.kind === 'PHONE')!;
    expect(text.slice(m.start, m.end)).to.equal(m.matched);
    expect(m.matched).to.include('081');
  });

  it('ข้อความ 200,000 ตัวอักษรหลายรูปแบบ จบภายใน 1 วินาที', () => {
    const t0 = Date.now();
    detectContact('a'.repeat(200_000));
    detectContact('ก'.repeat(200_000));
    detectContact('0'.repeat(200_000));
    detectContact('a@'.repeat(100_000));
    detectContact('line '.repeat(40_000));
    expect(Date.now() - t0).to.be.lessThan(1000);
  });
});
