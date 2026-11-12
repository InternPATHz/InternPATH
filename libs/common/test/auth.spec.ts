import { generateKeyPairSync } from 'node:crypto';
import { Reflector } from '@nestjs/core';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { AppException, JwtAuthGuard, RolesGuard, IS_PUBLIC_KEY, ROLES_KEY } from '../src';

const { publicKey, privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const config: any = { get: (k: string) => (k === 'JWT_PUBLIC_KEY' ? publicKey : undefined) };

function ctx(headers: Record<string, string>, meta: Record<string, unknown> = {}, user?: unknown) {
  const req: any = { headers, user };
  const handler = () => undefined;
  const reflector = {
    getAllAndOverride: (key: string) => meta[key],
  } as unknown as Reflector;
  const context: any = {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => class {},
  };
  return { req, context, reflector };
}

const sign = (payload: object, opts: jwt.SignOptions = {}) =>
  jwt.sign(payload, privateKey, { algorithm: 'RS256', ...opts });

describe('JwtAuthGuard', () => {
  it('ผ่านเมื่อ Token ถูกต้องและตั้ง req.user', () => {
    const { req, context, reflector } = ctx({
      authorization: `Bearer ${sign({ sub: 'u1', role: 'STUDENT' }, { expiresIn: '5m' })}`,
    });
    expect(new JwtAuthGuard(reflector, config).canActivate(context)).to.equal(true);
    expect(req.user.sub).to.equal('u1');
  });

  it('ข้ามเมื่อ Endpoint เป็น @Public', () => {
    const { context, reflector } = ctx({}, { [IS_PUBLIC_KEY]: true });
    expect(new JwtAuthGuard(reflector, config).canActivate(context)).to.equal(true);
  });

  it('401 UNAUTHENTICATED เมื่อไม่มี Token', () => {
    const { context, reflector } = ctx({});
    expect(() => new JwtAuthGuard(reflector, config).canActivate(context))
      .to.throw(AppException)
      .with.property('code', 'UNAUTHENTICATED');
  });

  it('401 TOKEN_EXPIRED เมื่อหมดอายุ', () => {
    const token = sign({ sub: 'u1', role: 'STUDENT' }, { expiresIn: -10 });
    const { context, reflector } = ctx({ authorization: `Bearer ${token}` });
    expect(() => new JwtAuthGuard(reflector, config).canActivate(context))
      .to.throw(AppException)
      .with.property('code', 'TOKEN_EXPIRED');
  });

  it('ปฏิเสธ Token ที่เซ็นด้วยคีย์อื่น', () => {
    const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const token = jwt.sign({ sub: 'u1' }, other.privateKey, { algorithm: 'RS256' });
    const { context, reflector } = ctx({ authorization: `Bearer ${token}` });
    expect(() => new JwtAuthGuard(reflector, config).canActivate(context))
      .to.throw(AppException)
      .with.property('code', 'UNAUTHENTICATED');
  });

  it('ปฏิเสธ Token ที่ใช้ alg=none', () => {
    const token = jwt.sign({ sub: 'u1' }, '', { algorithm: 'none' });
    const { context, reflector } = ctx({ authorization: `Bearer ${token}` });
    expect(() => new JwtAuthGuard(reflector, config).canActivate(context)).to.throw(AppException);
  });
});

describe('RolesGuard', () => {
  it('ผ่านเมื่อไม่ระบุ @Roles', () => {
    const { context, reflector } = ctx({});
    expect(new RolesGuard(reflector).canActivate(context)).to.equal(true);
  });

  it('ผ่านเมื่อ Role ตรง', () => {
    const { context, reflector } = ctx({}, { [ROLES_KEY]: ['PLATFORM_ADMIN'] }, { role: 'PLATFORM_ADMIN' });
    expect(new RolesGuard(reflector).canActivate(context)).to.equal(true);
  });

  it('403 FORBIDDEN_ROLE เมื่อ Role ไม่ตรง', () => {
    const { context, reflector } = ctx({}, { [ROLES_KEY]: ['PLATFORM_ADMIN'] }, { role: 'STUDENT' });
    expect(() => new RolesGuard(reflector).canActivate(context))
      .to.throw(AppException)
      .with.property('code', 'FORBIDDEN_ROLE');
  });
});
