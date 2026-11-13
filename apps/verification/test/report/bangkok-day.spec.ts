import { expect } from 'chai';
import { startOfBangkokDay, startOfNextBangkokDay } from '../../src/report/bangkok-day';

describe('bangkok-day: ปฏิเสธขอบวันตามปฏิทิน Asia/Bangkok (UTC+7)', () => {
  it('23:59:59 ไทย (16:59:59Z) ⇒ เริ่มวัน 00:00 ไทยของวันนั้น (17:00Z วันก่อน)', () => {
    expect(startOfBangkokDay(new Date('2026-11-14T16:59:59Z')).toISOString()).to.equal('2026-11-13T17:00:00.000Z');
  });

  it('เที่ยงคืนไทยพอดี (17:00:00Z) ⇒ วันใหม่', () => {
    expect(startOfBangkokDay(new Date('2026-11-14T17:00:00Z')).toISOString()).to.equal('2026-11-14T17:00:00.000Z');
  });

  it('startOfNextBangkokDay = เริ่มวันถัดไป (+24 ชม.)', () => {
    expect(startOfNextBangkokDay(new Date('2026-11-14T16:59:59Z')).toISOString()).to.equal('2026-11-14T17:00:00.000Z');
    expect(startOfNextBangkokDay(new Date('2026-11-14T17:00:00Z')).toISOString()).to.equal('2026-11-15T17:00:00.000Z');
  });
});
