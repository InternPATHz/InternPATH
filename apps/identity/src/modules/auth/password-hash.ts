import { randomBytes } from 'node:crypto';
import * as argon2 from 'argon2';

const MEMORY_KIB = 64 * 1024;
const ITERATIONS = 3;
const PARALLELISM = 1;
const KEY_LENGTH = 32;

/** PHC string, compatible with the Argon2id hashes created by @noble/hashes. */
export async function hashPassword(password: string): Promise<string> {
  return argon2.hash(password, {
    type: argon2.argon2id,
    version: 0x13,
    memoryCost: MEMORY_KIB,
    timeCost: ITERATIONS,
    parallelism: PARALLELISM,
    hashLength: KEY_LENGTH,
    salt: randomBytes(16),
  });
}

export async function verifyPassword(stored: string, password: string): Promise<boolean> {
  const match = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/u.exec(stored);
  if (!match) return false;
  const memory = Number(match[1]);
  const iterations = Number(match[2]);
  const parallelism = Number(match[3]);
  const salt = Buffer.from(match[4], 'base64');
  const expected = Buffer.from(match[5], 'base64');
  if (memory < 8192 || memory > MEMORY_KIB || iterations < 1 || iterations > 10 || parallelism < 1 || parallelism > 4 || salt.length < 16 || expected.length !== KEY_LENGTH) return false;
  try {
    return await argon2.verify(stored, password);
  } catch {
    return false;
  }
}
