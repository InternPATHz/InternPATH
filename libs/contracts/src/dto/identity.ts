// ต้องตรงกับ docs/api-contract.md §4 (Identity) — เฉพาะ body/response ที่เอกสารระบุไว้
// Response ของ endpoint ที่เอกสารไม่ได้ระบุฟิลด์ (เช่น GET /users/me, /companies/me) ยังไม่ถูกล็อก — ดูรายการช่องว่างท้ายเอกสาร api-contract
import type { CompanyStatus, JobCategory } from '../enums';
import type { PageQuery } from './common';
import type { AuthUser, CompanyDocType } from './identity-responses';

// ---- 4.1 Auth ----
/**
 * POST /auth/student-invitations/accept — นักศึกษาตั้งรหัสผ่านจากลิงก์คำเชิญที่อาจารย์สร้างให้ (ไม่มี register/student — ปรับ 2026-11-21)
 */
export interface AcceptStudentInvitationRequest {
  token: string;
  password: string;
  accept_privacy: true;
}

export interface RegisterCompanyRequest {
  company: {
    name: string;
    /** เลขทะเบียนนิติบุคคลเป็นตัวเลข 13 หลัก */
    registration_no: string;
    website?: string;
    phone?: string;
  };
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
  unlock_token?: string;
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
/** POST /advisor-links/students — อาจารย์เพิ่มนักศึกษา (ไม่มีการเลือกอาจารย์โดยนักศึกษา) */
export interface CreateStudentRequest {
  /** ต้องเป็น @ac.th ของมหาวิทยาลัยเดียวกับอาจารย์ */
  email: string;
  full_name: string;
  student_code: string;
  major: string;
  year_level: number;
}

/** PATCH /advisor-links/students/{student_id} */
export interface UpdateStudentRequest {
  full_name?: string;
  major?: string;
  year_level?: number;
}

/** GET /advisor-links/students?q=&year_level=&activation= */
export interface AdvisorStudentsQuery extends PageQuery {
  q?: string;
  year_level?: number;
  activation?: 'PENDING' | 'ACTIVE';
}

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
  /** สายงานของสมาชิกใหม่ 1–3 ค่า (README 5.6) */
  categories: JobCategory[];
}

/** PUT /companies/me/members/{user_id}/categories */
export interface UpdateMemberCategoriesRequest {
  categories: JobCategory[];
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
/** Public (ไม่ต้องล็อกอิน) — ตอบ `Paginated<DirectoryCompanyListItem>` */
export interface DirectoryCompaniesQuery extends Pick<PageQuery, 'page' | 'page_size'> {
  q?: string;
  category?: string;
  partner?: boolean;
  /** UUID คั่นด้วย `,` สูงสุด 50 ตัว — ดึงหลายบริษัทในครั้งเดียว (ใช้ดึงคะแนนดาวของการ์ดงาน) */
  ids?: string;
}

/** รายการจาก GET /directory/companies (เฉพาะบริษัท VERIFIED) */
export interface DirectoryCompanyListItem {
  id: string;
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
