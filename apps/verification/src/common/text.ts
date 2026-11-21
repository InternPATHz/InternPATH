// อักขระความกว้างศูนย์: ZWSP, ZWNJ, ZWJ, BOM/ZWNBSP, word joiner
const ZERO_WIDTH_CODE_POINTS = new Set([0x200b, 0x200c, 0x200d, 0xfeff, 0x2060]);

/**
 * ทำข้อความให้อยู่ในรูปมาตรฐานก่อนสแกน: Unicode NFC และตัดอักขระความกว้างศูนย์
 * (ใช้หลบการจับคำ) ไม่เปลี่ยนตัวพิมพ์ — ออฟเซ็ตของผลสแกนทั้งหมดอ้างอิงข้อความหลังฟังก์ชันนี้
 * และข้อความนี้คือสิ่งที่เก็บ/แสดงให้ Admin เห็น
 */
export function normalizeText(s: string): string {
  let out = '';
  for (const ch of s.normalize('NFC')) {
    if (!ZERO_WIDTH_CODE_POINTS.has(ch.codePointAt(0) as number)) out += ch;
  }
  return out;
}
