import { expect } from 'chai';

/**
 * กฎเวลาของ Event (event-contract §3 — PM ตัดสิน 2026-11-18, E04-05): ทุก `*_at` เป็น ISO-8601 UTC
 * ลงท้าย `Z` เศษวินาที 0–3 หลัก (ระดับมิลลิวินาที) — ผู้รับ (Job) ปฏิเสธค่าที่ละเอียดกว่านั้น
 * จึงต้องกัน regression ฝั่งผู้ส่ง (ใช้ `Date#toISOString()` เสมอ ห้ามประกอบสตริงเวลาเอง)
 */
export const EVENT_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** ทุกฟิลด์ `*_at` ใน payload ตรงรูปแบบ เป็นวันที่ที่มีอยู่จริง และแปลงเป็น `Date` แล้วไม่เสียความละเอียด */
export function expectEventTimestamps(payload: Record<string, unknown>, label: string): void {
  const keys = Object.keys(payload).filter((key) => key.endsWith('_at'));
  expect(keys.length, `${label}: ต้องมีฟิลด์ *_at อย่างน้อยหนึ่งตัว`).to.be.greaterThan(0);
  for (const key of keys) {
    const value = payload[key];
    expect(value, `${label}.${key}`).to.be.a('string');
    expect(value as string, `${label}.${key}`).to.match(EVENT_TIMESTAMP);
    const parsed = new Date(value as string);
    expect(Number.isNaN(parsed.getTime()), `${label}.${key} ต้องเป็นวันที่ที่มีอยู่จริง`).to.equal(false);
    // ส่วนวินาทีต้องเท่าเดิมหลังแปลงเป็น Date (ไม่ถูกปัดหรือเลื่อน)
    expect(parsed.toISOString().slice(0, 19), `${label}.${key} ต้องไม่ถูกปัด`).to.equal((value as string).slice(0, 19));
  }
}
