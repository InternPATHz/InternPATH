// Response ที่ api-contract.md เดิมไม่ได้ระบุฟิลด์ — PM ตัดสินจาก data-schema.md (2026-11-14)
// กฎ: ไม่ส่ง password_hash / token hash / object_key (ใช้ Signed URL แทน) — ดู api-contract §1
import type { AdvisorLinkStatus, CompanyMemberRole, CompanyStatus, JobCategory, Role, UserStatus } from '../enums';
import type { DirectoryCompanyListItem } from './identity';

/** `user` ใน LoginResponse และ GET /users/me */
export interface AuthUser {
  id: string;
  email: string;
  full_name: string;
  phone?: string;
  role: Role;
  status: UserStatus;
  email_verified: boolean;
  created_at: string;
}

/** GET /users/me — ผู้ใช้ + สถานะ advisor link (S) / ข้อมูลอาจารย์ (A) / บริษัท (H) */
export interface UserMeResponse extends AuthUser {
  student?: {
    student_code: string;
    major: string;
    year_level: number;
    advisor_link_status: AdvisorLinkStatus;
    advisor_id?: string;
  };
  advisor?: { department?: string };
  company?: { id: string; name: string; status: CompanyStatus; member_role: CompanyMemberRole; categories?: JobCategory[] };
}

export interface UpdateMeRequest {
  full_name?: string;
  phone?: string;
}

/** POST /advisor-links/students → 201 */
export interface CreateStudentResponse {
  student_user_id: string;
  email: string;
  invitation_expires_at: string;
}

/** GET /advisor-links/students — นักศึกษาในความดูแลสำหรับจัดการบัญชี (รายชื่อพร้อมสถานะการฝึกอยู่ที่ Lifecycle `GET /advisor/students`) */
export interface AdvisorStudentItem {
  user_id: string;
  full_name: string;
  email: string;
  student_code: string;
  major: string;
  year_level: number;
  /** `PENDING` = ยังไม่ตั้งรหัสผ่านจากลิงก์คำเชิญ */
  activation_status: 'PENDING' | 'ACTIVE';
  invitation_expires_at?: string;
}

/** GET /companies/me */
export interface CompanyMeResponse {
  id: string;
  name: string;
  registration_no: string;
  website?: string;
  phone?: string;
  logo_url?: string;
  status: CompanyStatus;
  /** เหตุผล NEED_MORE_INFO / REJECTED / SUSPENDED */
  review_note?: string;
  university_partner: boolean;
  featured_enabled: boolean;
  fast_track_enabled: boolean;
}

export interface UpdateCompanyRequest {
  name?: string;
  website?: string;
  phone?: string;
}

/** ค่า doc_type ของเอกสารบริษัท (PM ตัดสิน — เพิ่มค่าต้องแก้เอกสาร) */
export type CompanyDocType = 'REGISTRATION_CERT' | 'VAT_CERT' | 'AUTHORIZATION_LETTER' | 'OTHER';

/** GET /companies/me/documents */
export interface CompanyDocumentItem {
  id: string;
  doc_type: CompanyDocType;
  mime: string;
  size_bytes: number;
  /** Signed URL อายุสั้น */
  url: string;
  created_at: string;
}

/** GET /companies/me/members */
export interface CompanyMemberItem {
  user_id: string;
  full_name: string;
  email: string;
  member_role: CompanyMemberRole;
  /** สายงานของ HR Member (Owner = ทุกสายงาน จึงเป็น []) */
  categories: JobCategory[];
  joined_at: string;
}

/** GET /companies/me/invitations (Owner) — คำเชิญที่ยังรอรับ ไม่คืนโทเคน; ห่อเป็น `{ data }` */
export interface CompanyInvitationItem {
  id: string;
  email: string;
  categories: JobCategory[];
  invited_at: string;
  expires_at: string;
}

/** GET /companies/me/owner-transfer — คำขอโอน Owner ที่ค้างอยู่ของผู้เรียก (ไม่มี ⇒ 404) */
export interface OwnerTransferPendingResponse {
  /** `OUTGOING` = ผู้เรียกเป็น Owner ที่ขอโอน, `INCOMING` = ผู้เรียกเป็นผู้รับ */
  direction: 'OUTGOING' | 'INCOMING';
  other_user: { user_id: string; full_name: string };
  requested_at: string;
}

/** GET /directory/companies/{id} */
export interface DirectoryCompanyDetail extends DirectoryCompanyListItem {
  id: string;
  website?: string;
}

/** GET /admin/companies */
export interface AdminCompanyListItem {
  id: string;
  name: string;
  registration_no: string;
  status: CompanyStatus;
  created_at: string;
}

/** GET /admin/companies/{id} — รวมเอกสารและเกณฑ์อนุมัติ (README 5.6) */
export interface AdminCompanyDetail extends CompanyMeResponse {
  email_domain: string;
  documents: CompanyDocumentItem[];
  members: CompanyMemberItem[];
}

/** GET /admin/advisors */
export interface AdminAdvisorListItem {
  id: string;
  full_name: string;
  email: string;
  department?: string;
  status: UserStatus;
  created_at: string;
}

/** GET /admin/users — Admin account directory and advisor transfer lookup. */
export interface AdminUserListItem {
  id: string;
  full_name: string;
  email: string;
  role: Role;
  status: UserStatus;
  university_id: string | null;
  advisor_id: string | null;
  student_code: string | null;
  company_id: string | null;
  created_at: string;
}

// ---- §9 Internal (identity) ----
/** GET /internal/v1/users/{user_id}/contact (และรายการใน /contacts?ids=) */
export interface UserContact {
  user_id: string;
  email: string;
  full_name: string;
}

/** GET /internal/v1/students/{user_id} */
export interface InternalStudentResponse {
  /** ชื่อแสดงผล (HR/อาจารย์ใน Lifecycle) — ผู้รับห้ามเก็บลง DB/cache/Event/log */
  full_name: string;
  major: string;
  year_level: number;
  university_id: string;
  email_verified: boolean;
  advisor_id?: string;
  advisor_link_status: AdvisorLinkStatus;
}

/**
 * GET /internal/v1/students/names?ids= (≤ 100, ผู้เรียก lifecycle) — ชื่อนักศึกษาสำหรับหน้ารายการ
 * ไม่มีอีเมล; คืนเฉพาะนักศึกษา ACTIVE (เงื่อนไขเดียวกับ `students/{id}`) — บัญชีถูกระงับ/ลบ/ยังไม่ยืนยัน
 * และ id ที่ไม่ใช่นักศึกษาจะไม่อยู่ในผลลัพธ์
 */
export type InternalStudentNamesResponse = Array<{ user_id: string; full_name: string }>;

/**
 * GET /internal/v1/students/summaries?ids= (≤ 100, ผู้เรียก lifecycle) — สรุปนักศึกษาสำหรับหน้ารายการของอาจารย์
 * ข้ามบัญชีที่ลบแล้วและ id ที่ไม่ใช่นักศึกษา; ผู้รับห้ามเก็บ `full_name` ลง DB/cache/Event/log
 */
export type InternalStudentSummariesResponse = Array<{
  user_id: string;
  full_name: string;
  student_code: string;
  major: string;
  year_level: number;
}>;

/** GET /internal/v1/companies/{company_id}/members */
export type InternalCompanyMembersResponse = Array<{ user_id: string; member_role: CompanyMemberRole }>;

export interface ConsentCheckRequest {
  student_user_id: string;
  company_id: string;
}

export interface ConsentCheckResponse {
  has_consent: boolean;
  /** Consent ที่ใช้อยู่ — ส่งเมื่อ `has_consent = true` (ผูก `applications.resume_consent_id`) */
  consent_id?: string;
}

/**
 * POST /internal/v1/consents/check-batch (ผู้เรียก lifecycle) — ตรวจ Consent หลายนักศึกษากับบริษัทเดียว
 * `student_user_ids` 1–100 รายการ (ตัดซ้ำ) เงื่อนไขเดียวกับ `consents/check`
 */
export interface ConsentCheckBatchRequest {
  company_id: string;
  student_user_ids: string[];
}

/** คืนเฉพาะนักศึกษาที่มี Consent (เรียงตามคำขอ) — id ที่ไม่อยู่ในผลลัพธ์ = ไม่มี Consent */
export type ConsentCheckBatchResponse = Array<{ student_user_id: string; consent_id: string }>;

/** GET /internal/v1/admins */
export type InternalAdminsResponse = Array<{ user_id: string }>;

/** GET /internal/v1/denylist */
export type InternalDenylistResponse = Array<{ user_id: string }>;
