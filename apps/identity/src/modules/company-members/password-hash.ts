import { randomBytes, timingSafeEqual } from 'node:crypto';
import { argon2idAsync } from '@noble/hashes/argon2';

const MEMORY_KIB = 64 * 1024;
const ITERATIONS = 3;
const PARALLELISM = 1;
const KEY_LENGTH = 32;
const encode = (value: Uint8Array): string => Buffer.from(value).toString('base64').replace(/=+$/u, '');

/** Same Argon2id PHC format and parameters as the open Identity Auth PR. */
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await argon2idAsync(password, salt, { t: ITERATIONS, m: MEMORY_KIB, p: PARALLELISM, dkLen: KEY_LENGTH });
  return `$argon2id$v=19$m=${MEMORY_KIB},t=${ITERATIONS},p=${PARALLELISM}$${encode(salt)}$${encode(key)}`;
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(stored);
  if (!match) return false;
  const memory = Number(match[1]); const iterations = Number(match[2]); const parallelism = Number(match[3]);
  const salt = Buffer.from(match[4], 'base64'); const expected = Buffer.from(match[5], 'base64');
  if (memory < 8192 || memory > MEMORY_KIB || iterations < 1 || iterations > 10 || parallelism < 1 || parallelism > 4 ||
      salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  const actual = await argon2idAsync(password, salt, { t: iterations, m: memory, p: parallelism, dkLen: expected.length });
  return timingSafeEqual(Buffer.from(actual), expected);
}
