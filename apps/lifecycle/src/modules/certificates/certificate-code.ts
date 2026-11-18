import { randomInt } from 'node:crypto';
import { bangkokToday } from '../../state-machine/dates';

/**
 * Certificate ID ที่แสดงบนใบรับรองและอยู่ใน QR (data-schema §6 `certificate_code`) — สุ่ม เดาไม่ได้
 * รูปแบบ `IP-<ปี ค.ศ.>-<8 ตัวอักษร>` ใช้ตัวอักษร Crockford Base32 (ไม่มี I, L, O, U — อ่านผิดยาก)
 * 32^8 ≈ 1.1 ล้านล้านค่าต่อปี + Rate limit 30 ครั้ง/นาที/IP ที่ Gateway ⇒ ไล่เดาไม่ได้ในทางปฏิบัติ
 * ใช้ `crypto.randomInt` (CSPRNG) ไม่ใช่ `Math.random`
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const RANDOM_LENGTH = 8;

export const CERTIFICATE_CODE_PATTERN = /^IP-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/;

export function generateCertificateCode(issuedAt: Date): string {
  let random = '';
  for (let i = 0; i < RANDOM_LENGTH; i += 1) random += ALPHABET[randomInt(ALPHABET.length)];
  // ปีตามปฏิทินกรุงเทพ (README §5.3) — ออกใบคืนวันที่ 31 ธ.ค. เวลาไทยยังเป็นปีเดิม
  return `IP-${bangkokToday(issuedAt).getUTCFullYear()}-${random}`;
}

/** รูปแบบผิด ⇒ ตอบ 404 เหมือนไม่พบ (api-contract §7.5) — ไม่ต้องถาม DB */
export function isCertificateCode(value: string): boolean {
  return CERTIFICATE_CODE_PATTERN.test(value);
}
