import { CanActivate, ExecutionContext, Injectable, SetMetadata } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import { AppException } from '@internpath/common';
import * as jwt from 'jsonwebtoken';

const CALLERS = 'identity_internal_callers';
export type ServiceCaller = 'gateway' | 'notification' | 'lifecycle';
export const InternalCallers = (...callers: ServiceCaller[]) => SetMetadata(CALLERS, callers);

const SECRET_ENV: Record<ServiceCaller, string> = {
  gateway: 'IDENTITY_SERVICE_SECRET_GATEWAY',
  notification: 'IDENTITY_SERVICE_SECRET_NOTIFICATION',
  lifecycle: 'IDENTITY_SERVICE_SECRET_LIFECYCLE',
};

/** Service Token เป็น HS256, typ=service, aud=identity และมีอายุไม่เกิน 5 นาที */
@Injectable()
export class ServiceTokenGuard implements CanActivate {
  constructor(private readonly reflector: Reflector, private readonly config: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const allowed = this.reflector.getAllAndOverride<ServiceCaller[]>(CALLERS, [context.getHandler(), context.getClass()]);
    if (!allowed?.length) throw new AppException('AUTH_NOT_CONFIGURED', 'Internal allow-list is missing', 500);
    const request = context.switchToHttp().getRequest();
    const authorization: unknown = request.headers?.authorization;
    if (typeof authorization !== 'string' || !/^Bearer [^ ]+$/u.test(authorization)) {
      throw new AppException('UNAUTHENTICATED', 'ต้องใช้ Service Token', 401);
    }
    const token = authorization.slice(7);
    const unverified = jwt.decode(token, { complete: true });
    const issuer = unverified && typeof unverified.payload === 'object' ? unverified.payload.iss : undefined;
    if (!issuer || !Object.hasOwn(SECRET_ENV, issuer)) throw new AppException('UNAUTHENTICATED', 'Service Token ไม่ถูกต้อง', 401);
    const caller = issuer as ServiceCaller;
    const secret = this.config.get<string>(SECRET_ENV[caller]);
    if (!secret || secret.length < 32) throw new AppException('AUTH_NOT_CONFIGURED', 'Service Token secret is missing', 503);
    try {
      const verified = jwt.verify(token, secret, { algorithms: ['HS256'], audience: 'identity', issuer: caller, complete: true });
      if (typeof verified.payload !== 'object' || verified.header.typ !== 'service' ||
          typeof verified.payload.iat !== 'number' || typeof verified.payload.exp !== 'number' ||
          typeof verified.payload.jti !== 'string' || verified.payload.iat > Math.floor(Date.now() / 1000) + 5 ||
          verified.payload.exp <= verified.payload.iat ||
          verified.payload.exp - verified.payload.iat > 300) {
        throw new Error('Invalid service token claims');
      }
    } catch {
      throw new AppException('UNAUTHENTICATED', 'Service Token ไม่ถูกต้องหรือหมดอายุ', 401);
    }
    if (!allowed.includes(caller)) throw new AppException('FORBIDDEN_ROLE', 'Service นี้ไม่มีสิทธิ์เรียก endpoint', 403);
    request.serviceCaller = caller;
    return true;
  }
}
