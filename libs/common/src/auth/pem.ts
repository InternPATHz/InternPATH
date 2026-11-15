/**
 * ทำให้ค่า PEM ที่มาจาก env var ใช้งานได้ ไม่ว่าจะเขียนมาในรูปแบบไหน:
 * - ขึ้นบรรทัดใหม่แบบ `\n` (แบ็กสแลชตัวเดียว) หรือ `\\n` (สองตัวขึ้นไป — พบเมื่อ escape ซ้ำตอนคัดลอก/ตั้งค่า)
 * - ครอบด้วยเครื่องหมายคำพูด "..." หรือ '...'
 * - ขึ้นบรรทัดจริง (หลายบรรทัดใน .env) รวมถึง CRLF
 * คืนสตริงว่างถ้าไม่ได้ตั้งค่า เพื่อให้ผู้เรียกตัดสินใจเองว่าจะ error อย่างไร
 */
export function normalizePemKey(value: string | undefined | null): string {
  let key = (value ?? '').trim();
  if (key.length >= 2 && (key[0] === '"' || key[0] === "'") && key.endsWith(key[0])) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/\r/g, '').replace(/\\+n/g, '\n');
}
