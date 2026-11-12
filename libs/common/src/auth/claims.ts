/** Claims ของ Access Token (docs/architecture.md §5) */
export type Role = 'STUDENT' | 'COMPANY_HR' | 'ADVISOR' | 'PLATFORM_ADMIN';

export interface JwtClaims {
  sub: string; // user_id
  role: Role;
  company_id?: string;
  company_role?: 'OWNER' | 'MEMBER';
  advisor_id?: string;
  university_id?: string;
  jti: string;
  iat: number;
  exp: number;
}
