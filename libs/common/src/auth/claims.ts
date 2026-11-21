/** Claims ของ Access Token (docs/architecture.md §5) */
export type Role = 'STUDENT' | 'COMPANY_HR' | 'ADVISOR' | 'PLATFORM_ADMIN';

export interface JwtClaims {
  sub: string; // user_id
  role: Role;
  company_id?: string;
  company_role?: 'OWNER' | 'MEMBER';
  /** สายงานของ HR Member (`JobCategory`); Owner ไม่มีฟิลด์นี้ = ทุกสายงาน */
  company_categories?: Array<'TECH_IT' | 'BUSINESS_MARKETING' | 'CORPORATE_SERVICES'>;
  advisor_id?: string;
  university_id?: string;
  jti: string;
  iat: number;
  exp: number;
}
