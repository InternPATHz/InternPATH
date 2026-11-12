// สร้างคู่คีย์ RS256 สำหรับ JWT แล้วพิมพ์เป็นบรรทัดสำหรับวางใน .env
// ใช้: pnpm keys:generate   (ห้าม commit ค่าที่ได้)
import { generateKeyPairSync } from 'node:crypto';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const oneLine = (pem) => pem.trim().replace(/\r?\n/g, '\\n');

console.log(`JWT_PRIVATE_KEY="${oneLine(privateKey)}"`);
console.log(`JWT_PUBLIC_KEY="${oneLine(publicKey)}"`);
