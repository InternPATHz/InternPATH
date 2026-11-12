import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';
import type { JwtClaims, Role } from './claims';

export const IS_PUBLIC_KEY = 'isPublic';
export const ROLES_KEY = 'roles';

/** Endpoint สาธารณะ — ข้ามการตรวจ JWT */
export const Public = () => SetMetadata(IS_PUBLIC_KEY, true);

/** จำกัด Role ที่เข้าถึงได้ (ใช้คู่กับ RolesGuard) */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/** ดึง Claims ของผู้ใช้ปัจจุบัน (ตั้งโดย JwtAuthGuard) */
export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext) => {
  return ctx.switchToHttp().getRequest().user as JwtClaims;
});
