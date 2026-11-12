import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppException } from '../errors/app-exception';
import type { JwtClaims, Role } from './claims';
import { ROLES_KEY } from './decorators';

/** ตรวจ Role ที่ทุก Service (ไม่พึ่ง Gateway อย่างเดียว) — ถ้าไม่ระบุ @Roles ถือว่าผ่าน */
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const roles = this.reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (!roles || roles.length === 0) return true;

    const user = context.switchToHttp().getRequest().user as JwtClaims | undefined;
    if (!user || !roles.includes(user.role)) {
      throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์เข้าถึง', 403);
    }
    return true;
  }
}
