// ต้องตรงกับ docs/api-contract.md §4 (Identity) — เฉพาะ body/response ที่เอกสารระบุไว้
// Response ของ endpoint ที่เอกสารไม่ได้ระบุฟิลด์ (เช่น GET /users/me, /companies/me) ยังไม่ถูกล็อก — ดูรายการช่องว่างท้ายเอกสาร api-contract
import type { CompanyStatus } from '../enums';
import type { AuthUser, CompanyDocType } from './identity-responses';

// ---- 4.1 Auth ----
export interface RegisterStudentRequest {
  /** ต้องเป็น @ac.th */
  email: string;
  password: string;
  full_name: string;
  student_code: string;
  major: string;
  year_level: number;
  accept_privacy: true;
}

export interface RegisterCompanyRequest {
  company: { name: string; registration_no: string; website?: string; phone?: string };
  /** อีเมลโดเมนองค์กร — อีเมลสาธารณะ ⇒ `PUBLIC_EMAIL_NOT_ALLOWED` */
  user: { email: string; password: string; full_name: string };
  accept_privacy: true;
}

export interface VerifyEmailRequest {
  token: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface LoginResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user: AuthUser;
}

export interface RefreshRequest {
  refresh_token: string;
}

export interface ForgotPasswordRequest {
  email: string;
}

export interface ResetPasswordRequest {
  token: string;
  new_password: string;
}

// ---- 4.2 ผู้ใช้/อาจารย์ ----
export interface RequestAdvisorLinkRequest {
  advisor_id: string;
}

export type AdvisorLinkRequestAction = 'confirm' | 'reject';

export interface RecordConsentRequest {
  type: 'RESUME_SHARE';
  application_id?: string;
  target_company_id: string;
}

// ---- 4.3 บริษัท/ทีม ----
export interface UploadCompanyDocumentFields {
  doc_type: CompanyDocType;
}

export interface InviteMemberRequest {
  /** โดเมนองค์กรเท่านั้น */
  email: string;
}

export interface AcceptInvitationRequest {
  token: string;
  password: string;
  full_name: string;
}

export interface OwnerTransferRequest {
  to_user_id: string;
}

export type OwnerTransferAction = 'accept' | 'decline' | 'cancel';

// ---- 4.4 Directory ----
export interface DirectoryCompaniesQuery {
  q?: string;
  category?: string;
  partner?: boolean;
}

/** รายการจาก GET /directory/companies (เฉพาะบริษัท VERIFIED) */
export interface DirectoryCompanyListItem {
  name: string;
  logo_url?: string;
  university_partner: boolean;
  rating_avg: number;
  review_count: number;
}

// ---- 4.5 Admin ----
export type AdminCompanyAction = 'verify' | 'need-more-info' | 'reject' | 'suspend' | 'unsuspend';

export interface AdminCompanyActionRequest {
  /** บังคับ ยกเว้น `verify` / `unsuspend` */
  reason?: string;
}

export interface AdminCompaniesQuery {
  status?: CompanyStatus;
  page?: number;
}

export interface SetUniversityPartnerRequest {
  enabled: boolean;
}

export interface SetEntitlementsRequest {
  featured_enabled: boolean;
  fast_track_enabled: boolean;
}

export interface AssignOwnerRequest {
  user_id: string;
}

export type AdminAdvisorAction = 'approve' | 'reject';

export interface AdminMoveStudentAdvisorRequest {
  advisor_id: string;
}

export type AdminUserAction = 'suspend' | 'unsuspend';
