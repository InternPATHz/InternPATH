import type { JwtClaims } from '@internpath/common';
import * as jwt from 'jsonwebtoken';

const ROLES = new Set(['STUDENT', 'COMPANY_HR', 'ADVISOR', 'PLATFORM_ADMIN']);

export class AccessTokenError extends Error {
  constructor(public readonly code: 'UNAUTHENTICATED' | 'TOKEN_EXPIRED') {
    super(code);
  }
}

export function verifyAccessToken(authorization: unknown, publicKey: string): JwtClaims {
  if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/.test(authorization)) {
    throw new AccessTokenError('UNAUTHENTICATED');
  }
  try {
    const claims = jwt.verify(authorization.slice(7), publicKey, { algorithms: ['RS256'] });
    if (typeof claims !== 'object' || typeof claims.sub !== 'string' || !claims.sub ||
        !ROLES.has(claims.role) || typeof claims.jti !== 'string' || !claims.jti) {
      throw new Error('Invalid claims');
    }
    return claims as JwtClaims;
  } catch (error) {
    throw new AccessTokenError(error instanceof jwt.TokenExpiredError ? 'TOKEN_EXPIRED' : 'UNAUTHENTICATED');
  }
}
