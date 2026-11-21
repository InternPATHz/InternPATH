import { generateKeyPairSync, randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import type { JwtClaims, Role } from '@internpath/common';

/**
 * คีย์ RS256 สำหรับเทสต์ — เซ็น Access Token เองโดยไม่ต้องรอ Identity
 * ตั้ง `JWT_PUBLIC_KEY = TEST_JWT.publicKey` ใน ConfigModule ของเทสต์
 */
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

export const TEST_JWT = { privateKey, publicKey };

export type TestClaims = Partial<Omit<JwtClaims, 'iat' | 'exp' | 'jti'>> & { role: Role };

/** เซ็น Token ของผู้ใช้ (ค่าเริ่มต้นอายุ 15 นาที) */
export function signAccessToken(claims: TestClaims, expiresInSeconds = 900): string {
  const { sub, ...rest } = claims;
  return jwt.sign(rest, privateKey, {
    algorithm: 'RS256',
    subject: sub ?? randomUUID(),
    jwtid: randomUUID(),
    expiresIn: expiresInSeconds,
  });
}

export const bearer = (claims: TestClaims, expiresInSeconds?: number): string =>
  `Bearer ${signAccessToken(claims, expiresInSeconds)}`;

/** สายงานครบทั้งหมด — ใช้กับ HR Member ในเทสต์ทั่วไปที่ไม่ได้ทดสอบสิทธิ์ตามสายงาน */
export const ALL_CATEGORIES: Array<'TECH_IT' | 'BUSINESS_MARKETING' | 'CORPORATE_SERVICES'> = ['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES'];
