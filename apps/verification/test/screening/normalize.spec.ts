import { expect } from 'chai';
import { normalizeText } from '../../src/screening/normalize';

describe('normalizeText', () => {
  it('ตัดอักขระความกว้างศูนย์ออก', () => {
    expect(normalizeText('ก​ข‌‍﻿⁠ค')).to.equal('กขค');
  });

  it('แปลงรูป NFD เป็น NFC', () => {
    expect(normalizeText('é')).to.equal('é');
  });

  it('ไม่เปลี่ยนตัวพิมพ์ (ออฟเซ็ตทั้งหมดอ้างอิงข้อความหลังนี้)', () => {
    expect(normalizeText('ABC mlm')).to.equal('ABC mlm');
  });
});
