import { generateKeyPairSync, randomUUID } from 'node:crypto';
import type { Role } from '@internpath/common';
import * as jwt from 'jsonwebtoken';

export interface JwtKit {
  publicKey: string;
  token(claims: { role: Role; sub?: string; company_id?: string; company_role?: 'OWNER' | 'MEMBER' }): string;
}

/** คู่คีย์ RS256 สำหรับเทสต์ (สร้างใหม่ต่อการเรียก) — public key ใส่ใน JWT_PUBLIC_KEY ของ app ทดสอบ */
export function createJwtKit(): JwtKit {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return {
    publicKey,
    token: (claims) =>
      jwt.sign({ ...claims, sub: claims.sub ?? randomUUID(), jti: randomUUID() }, privateKey, {
        algorithm: 'RS256',
        expiresIn: '1h',
      }),
  };
}
