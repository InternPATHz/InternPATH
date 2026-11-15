import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { expect } from 'chai';
import { normalizePemKey } from '../src';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const oneLine = (pem: string, escape: string) => pem.trim().replace(/\n/g, escape);

describe('normalizePemKey', () => {
  it('คืนสตริงว่างเมื่อไม่ได้ตั้งค่า', () => {
    expect(normalizePemKey(undefined)).to.equal('');
    expect(normalizePemKey(null)).to.equal('');
    expect(normalizePemKey('   ')).to.equal('');
  });

  it('รองรับ \\n ตัวเดียว (รูปแบบมาตรฐาน)', () => {
    expect(normalizePemKey(oneLine(privateKey, '\\n'))).to.equal(privateKey.trim());
  });

  it('รองรับ \\\\n แบบ escape ซ้ำ (บั๊กที่ทำให้ล็อกอินได้ 500)', () => {
    expect(normalizePemKey(oneLine(privateKey, '\\\\n'))).to.equal(privateKey.trim());
    expect(normalizePemKey(oneLine(publicKey, '\\\\n'))).to.equal(publicKey.trim());
  });

  it('รองรับเครื่องหมายคำพูดครอบ', () => {
    expect(normalizePemKey(`"${oneLine(publicKey, '\\n')}"`)).to.equal(publicKey.trim());
    expect(normalizePemKey(`'${oneLine(publicKey, '\\\\n')}'`)).to.equal(publicKey.trim());
  });

  it('รองรับบรรทัดจริงและ CRLF และคงค่าที่ถูกต้องอยู่แล้วไว้', () => {
    expect(normalizePemKey(publicKey)).to.equal(publicKey.trim());
    expect(normalizePemKey(publicKey.replace(/\n/g, '\r\n'))).to.equal(publicKey.trim());
  });

  it('ผลลัพธ์ที่ได้ OpenSSL อ่านเป็น key ได้จริง', () => {
    for (const escape of ['\\n', '\\\\n', '\\\\\\n']) {
      expect(() => createPublicKey(normalizePemKey(oneLine(publicKey, escape)))).not.to.throw();
    }
  });
});
