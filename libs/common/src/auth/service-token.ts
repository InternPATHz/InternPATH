import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import * as jwt from 'jsonwebtoken';
import { AppException } from '../errors/app-exception';

const POLICY_KEY = 'service_token_policy';
const CALLERS_KEY = 'service_token_callers';

export interface ServiceTokenPolicyOptions {
  audience: string;
  secretEnvByCaller: Record<string, string>;
}

/** Set the target service and the secret env var for each trusted caller. */
export const ServiceTokenPolicy = (options: ServiceTokenPolicyOptions) => SetMetadata(POLICY_KEY, options);

/** Restrict an internal endpoint to the listed callers. */
export const InternalCallers = (...callers: string[]) => SetMetadata(CALLERS_KEY, callers);

/** Sign a short-lived HS256 token for a service-to-service request. */
export function signServiceToken(options: { issuer: string; audience: string; secret: string }): string {
  const { issuer, audience, secret } = options;
  if (!issuer || !audience || !secret || secret.length < 32) {
    throw new Error('Service Token requires an issuer, audience and secret of at least 32 characters');
  }
  return jwt.sign({}, secret, { algorithm: 'HS256', header: { alg: 'HS256', typ: 'service' },
    issuer, audience, expiresIn: 300, jwtid: randomUUID() });
}

/** Verify service tokens against this service's audience and per-caller secrets. */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    const policy = this.reflector.getAllAndOverride<ServiceTokenPolicyOptions>(POLICY_KEY, targets);
    const allowed = this.reflector.getAllAndOverride<string[]>(CALLERS_KEY, targets);
    if (!policy?.audience || !policy.secretEnvByCaller || !allowed?.length) {
      throw new AppException('AUTH_NOT_CONFIGURED', 'Internal service token policy or allow-list is missing', 500);
    }
    const request = context.switchToHttp().getRequest();
    const authorization: unknown = request.headers?.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/u.test(authorization)) {
      throw new AppException('UNAUTHENTICATED', 'ต้องใช้ Service Token', 401);
    }
    const token = authorization.slice(7);
    const unverified = jwt.decode(token, { complete: true });
    const issuer = unverified && typeof unverified.payload === 'object' ? unverified.payload.iss : undefined;
    if (typeof issuer !== 'string' || !Object.hasOwn(policy.secretEnvByCaller, issuer)) {
      throw new AppException('UNAUTHENTICATED', 'Service Token ไม่ถูกต้อง', 401);
    }
    const secret = this.config.get<string>(policy.secretEnvByCaller[issuer]);
    if (!secret || secret.length < 32) throw new AppException('AUTH_NOT_CONFIGURED', 'Service Token secret is missing', 503);
    try {
      const verified = jwt.verify(token, secret, { algorithms: ['HS256'], audience: policy.audience,
        issuer, complete: true });
      if (typeof verified.payload !== 'object' || verified.header.typ !== 'service' ||
          typeof verified.payload.iat !== 'number' || typeof verified.payload.exp !== 'number' ||
          typeof verified.payload.jti !== 'string' || verified.payload.iat > Math.floor(Date.now() / 1000) + 5 ||
          verified.payload.exp <= verified.payload.iat || verified.payload.exp - verified.payload.iat > 300) {
        throw new Error('Invalid service token claims');
      }
    } catch {
      throw new AppException('UNAUTHENTICATED', 'Service Token ไม่ถูกต้องหรือหมดอายุ', 401);
    }
    if (!allowed.includes(issuer)) throw new AppException('FORBIDDEN_ROLE', 'Service นี้ไม่มีสิทธิ์เรียก endpoint', 403);
    request.serviceCaller = issuer;
    return true;
  }
}
