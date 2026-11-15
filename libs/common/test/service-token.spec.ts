import { ExecutionContext } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { expect } from 'chai';
import * as jwt from 'jsonwebtoken';
import { AppException, InternalCallers, ServiceTokenGuard, ServiceTokenPolicy, signServiceToken } from '../src';

const secrets = { gateway: 'g'.repeat(32), notification: 'n'.repeat(32) };

@ServiceTokenPolicy({ audience: 'identity', secretEnvByCaller: {
  gateway: 'IDENTITY_SERVICE_SECRET_GATEWAY', notification: 'IDENTITY_SERVICE_SECRET_NOTIFICATION',
} })
class InternalController {
  @InternalCallers('notification')
  contact() { return undefined; }

  unconfigured() { return undefined; }
}

@ServiceTokenPolicy({ audience: 'job', secretEnvByCaller: { notification: 'JOB_SERVICE_SECRET_NOTIFICATION' } })
class JobController {
  @InternalCallers('notification')
  list() { return undefined; }
}

function guardFor(token?: string, method: 'contact' | 'unconfigured' = 'contact',
  env: Record<string, string> = {
    IDENTITY_SERVICE_SECRET_GATEWAY: secrets.gateway,
    IDENTITY_SERVICE_SECRET_NOTIFICATION: secrets.notification,
  }) {
  const request: { headers: { authorization?: string }; serviceCaller?: string } = {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  };
  const context = {
    getHandler: () => InternalController.prototype[method],
    getClass: () => InternalController,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
  const config = { get: (name: string) => env[name] } as unknown as ConfigService;
  return { request, context, guard: new ServiceTokenGuard(new Reflector(), config) };
}

describe('Service Token shared auth', () => {
  it('signs an HS256 service token with the expected audience, type, issuer and five-minute lifetime', () => {
    const token = signServiceToken({ issuer: 'notification', audience: 'identity', secret: secrets.notification });
    const decoded = jwt.decode(token, { complete: true })!;
    expect(decoded.header.alg).to.equal('HS256');
    expect(decoded.header.typ).to.equal('service');
    const claims = decoded.payload as jwt.JwtPayload;
    expect(claims.iss).to.equal('notification');
    expect(claims.aud).to.equal('identity');
    expect(claims.exp! - claims.iat!).to.equal(300);
    expect(claims.jti).to.be.a('string');
    const { request, context, guard } = guardFor(token);
    expect(guard.canActivate(context)).to.equal(true);
    expect(request.serviceCaller).to.equal('notification');
  });

  it('rejects missing or short signing secrets', () => {
    for (const secret of ['', 'x'.repeat(31)]) {
      expect(() => signServiceToken({ issuer: 'notification', audience: 'identity', secret })).to.throw();
    }
  });

  it('rejects missing tokens and a missing route allow-list', () => {
    const { context, guard } = guardFor();
    expect(() => guard.canActivate(context)).to.throw(AppException).with.property('code', 'UNAUTHENTICATED');
    const token = signServiceToken({ issuer: 'notification', audience: 'identity', secret: secrets.notification });
    const unconfigured = guardFor(token, 'unconfigured');
    expect(() => unconfigured.guard.canActivate(unconfigured.context))
      .to.throw(AppException).with.property('code', 'AUTH_NOT_CONFIGURED');
  });

  it('enforces the audience and per-route caller allow-list', () => {
    const wrongAudience = signServiceToken({ issuer: 'notification', audience: 'job', secret: secrets.notification });
    const invalid = guardFor(wrongAudience);
    expect(() => invalid.guard.canActivate(invalid.context))
      .to.throw(AppException).with.property('code', 'UNAUTHENTICATED');
    const gateway = signServiceToken({ issuer: 'gateway', audience: 'identity', secret: secrets.gateway });
    const denied = guardFor(gateway);
    expect(() => denied.guard.canActivate(denied.context))
      .to.throw(AppException).with.property('code', 'FORBIDDEN_ROLE');
  });

  it('uses the receiving service policy for another audience and secret env name', () => {
    const token = signServiceToken({ issuer: 'notification', audience: 'job', secret: secrets.notification });
    const { request, context, guard } = guardFor(token, 'contact', {
      JOB_SERVICE_SECRET_NOTIFICATION: secrets.notification,
    });
    const jobContext = { ...context, getHandler: () => JobController.prototype.list,
      getClass: () => JobController } as ExecutionContext;
    expect(guard.canActivate(jobContext)).to.equal(true);
    expect(request.serviceCaller).to.equal('notification');
  });

  it('rejects a token signed with another caller secret and reports an unconfigured verifier secret', () => {
    const forged = jwt.sign({}, secrets.gateway, { algorithm: 'HS256',
      header: { alg: 'HS256', typ: 'service' }, issuer: 'notification', audience: 'identity',
      expiresIn: 300, jwtid: 'forged' });
    const invalid = guardFor(forged);
    expect(() => invalid.guard.canActivate(invalid.context))
      .to.throw(AppException).with.property('code', 'UNAUTHENTICATED');
    const valid = signServiceToken({ issuer: 'notification', audience: 'identity', secret: secrets.notification });
    const missing = guardFor(valid, 'contact', { IDENTITY_SERVICE_SECRET_NOTIFICATION: 'short' });
    expect(() => missing.guard.canActivate(missing.context))
      .to.throw(AppException).with.property('code', 'AUTH_NOT_CONFIGURED');
  });
});
