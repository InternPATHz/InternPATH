import { AppException, JwtClaims } from '@internpath/common';

/**
 * ตรวจสอบความเป็นเจ้าของทรัพยากรที่ Service เองเสมอ (README §5.7)
 * ไม่พึ่งพาการกรองของ Gateway เพียงอย่างเดียว
 */

/** ตรวจสิทธิ์นักศึกษา: user.sub ต้องตรงกับ student_user_id */
export function assertStudentOwnership(user: JwtClaims, resourceStudentUserId: string): void {
  if (user.role === 'PLATFORM_ADMIN') return;
  if (user.sub !== resourceStudentUserId) {
    throw new AppException('NOT_OWNER_OF_RESOURCE', 'ไม่มีสิทธิ์เข้าถึงข้อมูลของนักศึกษาอื่น', 403);
  }
}

/** ตรวจสิทธิ์ HR: user.company_id ต้องตรงกับ company_id ของทรัพยากร */
export function assertCompanyOwnership(user: JwtClaims, resourceCompanyId: string): void {
  if (user.role === 'PLATFORM_ADMIN') return;
  if (!user.company_id || user.company_id !== resourceCompanyId) {
    throw new AppException('NOT_OWNER_OF_RESOURCE', 'ไม่มีสิทธิ์เข้าถึงข้อมูลของบริษัทอื่น', 403);
  }
}

/** ตรวจสิทธิ์อาจารย์: user.sub ต้องตรงกับ advisor_user_id */
export function assertAdvisorOwnership(user: JwtClaims, resourceAdvisorUserId: string | null | undefined): void {
  if (user.role === 'PLATFORM_ADMIN') return;
  if (!resourceAdvisorUserId || user.sub !== resourceAdvisorUserId) {
    throw new AppException('NOT_OWNER_OF_RESOURCE', 'ไม่มีสิทธิ์เข้าถึงข้อมูลของนักศึกษาที่ไม่ได้อยู่ในความดูแล', 403);
  }
}
