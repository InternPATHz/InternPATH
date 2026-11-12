import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Reflector } from '@nestjs/core';
import * as jwt from 'jsonwebtoken';
import { AppException } from '../errors/app-exception';
import type { JwtClaims } from './claims';
import { IS_PUBLIC_KEY } from './decorators';

/** ตรวจ Access Token ด้วย Public Key (RS256) ของ Identity — ไม่ต้องเรียก Identity ทุกคำขอ */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly config: ConfigService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) return true;

    const req = context.switchToHttp().getRequest();
    const header: string | undefined = req.headers?.authorization;
    const [scheme, token] = header?.split(' ') ?? [];
    if (scheme !== 'Bearer' || !token) {
      throw new AppException('UNAUTHENTICATED', 'ต้องเข้าสู่ระบบก่อน', 401);
    }

    const publicKey = (this.config.get<string>('JWT_PUBLIC_KEY') ?? '').replace(/\\n/g, '\n');
    if (!publicKey) {
      throw new AppException('AUTH_NOT_CONFIGURED', 'ระบบยังไม่ได้ตั้งค่า JWT_PUBLIC_KEY', 500);
    }

    try {
      req.user = jwt.verify(token, publicKey, { algorithms: ['RS256'] }) as JwtClaims;
      return true;
    } catch (e) {
      if (e instanceof jwt.TokenExpiredError) {
        throw new AppException('TOKEN_EXPIRED', 'Token หมดอายุ', 401);
      }
      throw new AppException('UNAUTHENTICATED', 'Token ไม่ถูกต้อง', 401);
    }
  }
}
