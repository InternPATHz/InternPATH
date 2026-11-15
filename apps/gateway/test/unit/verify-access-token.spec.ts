import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { AccessTokenError, verifyAccessToken } from '../../src/auth/verify-access-token';

describe('Gateway access-token verification', () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  const sign = (role: string, expiresIn = 900) => jwt.sign({ role }, privateKey,
    { algorithm: 'RS256', subject: randomUUID(), jwtid: randomUUID(), expiresIn });

  it('accepts a signed user token and rejects service or malformed tokens', () => {
    expect(verifyAccessToken(`Bearer ${sign('STUDENT')}`, publicKey).role).to.equal('STUDENT');
    for (const value of [undefined, 'Bearer', 'Basic abc', `Bearer ${sign('UNKNOWN')}`]) {
      expect(() => verifyAccessToken(value, publicKey)).to.throw(AccessTokenError)
        .with.property('code', 'UNAUTHENTICATED');
    }
    const service = jwt.sign({ role: 'STUDENT' }, 'secret', { algorithm: 'HS256', subject: randomUUID(), jwtid: randomUUID() });
    expect(() => verifyAccessToken(`Bearer ${service}`, publicKey)).to.throw(AccessTokenError)
      .with.property('code', 'UNAUTHENTICATED');
  });

  it('distinguishes an expired user token', () => {
    expect(() => verifyAccessToken(`Bearer ${sign('STUDENT', -1)}`, publicKey)).to.throw(AccessTokenError)
      .with.property('code', 'TOKEN_EXPIRED');
  });
});
