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

/**
 * แปลงข้อความ "สำหรับสแกนเท่านั้น" โดยคงความยาวเดิมทุกตำแหน่ง (Minor สไลซ์ 1 — กันการหลบแบบง่าย แบบ B):
 * ตัวอักษร ASCII เต็มความกว้าง (U+FF01–U+FF5E) → ASCII, ช่องว่างเต็มความกว้าง (U+3000) → ช่องว่าง, เลขไทย ๐–๙ → 0–9
 * ทุกตัวเป็น 1 code unit ทั้งก่อนและหลังแปลง ออฟเซ็ตของผลสแกนจึงยังอ้างข้อความที่ผ่าน normalizeText (ที่เก็บ/แสดงให้ Admin) ได้ตรง
 * ไม่ใช้กับข้อความที่เก็บ — แสดงตามที่ผู้ใช้พิมพ์
 */
export function foldForScan(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xff01 && c <= 0xff5e) out += String.fromCharCode(c - 0xfee0);
    else if (c === 0x3000) out += ' ';
    else if (c >= 0x0e50 && c <= 0x0e59) out += String.fromCharCode(c - 0x0e50 + 0x30);
    else out += s[i];
  }
  return out;
}
