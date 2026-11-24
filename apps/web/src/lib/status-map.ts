import { CircleCheck, CircleDashed, CircleX, Clock5, ScanSearch, type LucideIcon } from 'lucide-react';
import type { StatusTone } from '@/components/ui/status-badge';

// แมปค่า enum จากสัญญา API → ป้ายที่แสดง (ข้อความ, โทนสี, ไอคอน)
// ค่า enum อ้างอิง docs/data-schema.md §1 และความหมายใน README 5.1.1 / 5.2.1

export interface StatusView {
  label: string;
  tone: StatusTone;
  icon: LucideIcon;
}

export type StatusMap = Record<string, StatusView>;

const waitingHr: StatusView = { label: 'รอ HR พิจารณา', tone: 'warning', icon: Clock5 };

export const APPLICATION_STATUS: StatusMap = {
  PENDING: waitingHr,
  HR_ACCEPTED: { label: 'รอยืนยันข้อเสนอ', tone: 'info', icon: CircleDashed },
  ADVISOR_PENDING: { label: 'รออาจารย์อนุมัติ', tone: 'warning', icon: ScanSearch },
  ADVISOR_APPROVED: { label: 'รอ HR ยืนยันเริ่มงาน', tone: 'info', icon: CircleDashed },
  IN_PROGRESS: { label: 'กำลังฝึกงาน', tone: 'info', icon: CircleDashed },
  EVALUATED_PASS: { label: 'ประเมินผ่าน', tone: 'success', icon: CircleCheck },
  EVALUATED_FAIL: { label: 'ประเมินไม่ผ่าน', tone: 'danger', icon: CircleX },
  FAIL_DISPUTED: { label: 'รออาจารย์ตัดสินข้อโต้แย้ง', tone: 'warning', icon: ScanSearch },
  REEVALUATION_REQUESTED: { label: 'รอ HR ประเมินใหม่', tone: 'warning', icon: ScanSearch },
  // COMPLETED: หน้าที่ใช้ควร override ตาม academic_result (ACADEMIC_FAIL / REPEAT_REQUIRED ไม่ควรเป็นสีเขียว)
  COMPLETED: { label: 'เสร็จสิ้น', tone: 'success', icon: CircleCheck },
  HR_REJECTED: { label: 'บริษัทไม่รับ', tone: 'danger', icon: CircleX },
  ADVISOR_REJECTED: { label: 'อาจารย์ไม่อนุมัติ', tone: 'danger', icon: CircleX },
  STUDENT_DECLINED: { label: 'ปฏิเสธข้อเสนอ', tone: 'neutral', icon: CircleX },
  WITHDRAWN: { label: 'ถอนใบสมัคร', tone: 'neutral', icon: CircleX },
  OFFER_RESCINDED: { label: 'ถอนข้อเสนอ', tone: 'neutral', icon: CircleX },
  TERMINATED: { label: 'ยุติกลางคัน', tone: 'neutral', icon: CircleX },
  NO_EVALUATION: { label: 'ไม่มีการประเมิน', tone: 'neutral', icon: Clock5 },
  EXPIRED: { label: 'หมดเวลา', tone: 'neutral', icon: Clock5 },
  CANCELLED: { label: 'ยกเลิก', tone: 'neutral', icon: CircleX },
};

export const JOB_STATUS: StatusMap = {
  DRAFT: { label: 'ร่าง', tone: 'neutral', icon: Clock5 },
  VERIFYING: { label: 'กำลังตรวจสอบ', tone: 'warning', icon: ScanSearch },
  PENDING_REVIEW: { label: 'รอ Admin ตรวจ', tone: 'warning', icon: ScanSearch },
  PUBLISHED: { label: 'เปิดรับสมัคร', tone: 'success', icon: CircleCheck },
  AUTO_REJECTED: { label: 'ไม่ผ่านการตรวจ', tone: 'danger', icon: CircleX },
  ADMIN_REJECTED: { label: 'ไม่ผ่านการตรวจ', tone: 'danger', icon: CircleX },
  SUSPENDED: { label: 'ถูกระงับ', tone: 'danger', icon: CircleX },
  REMOVED: { label: 'ปิดแล้ว', tone: 'neutral', icon: Clock5 },
  CLOSED: { label: 'ปิดแล้ว', tone: 'neutral', icon: Clock5 },
};

export const COMPANY_STATUS: StatusMap = {
  PENDING: { label: 'รอตรวจสอบ', tone: 'warning', icon: ScanSearch },
  NEED_MORE_INFO: { label: 'ขอข้อมูลเพิ่ม', tone: 'warning', icon: ScanSearch },
  VERIFIED: { label: 'ผ่านการรับรอง', tone: 'success', icon: CircleCheck },
  REJECTED: { label: 'ไม่ผ่านการรับรอง', tone: 'danger', icon: CircleX },
  SUSPENDED: { label: 'ถูกระงับ', tone: 'danger', icon: CircleX },
};

// ป้ายข้อความล้วนของค่า enum ฝั่งบัญชีผู้ใช้ (ไม่ต้องมีโทนสี) — ค่าที่ไม่รู้จักแสดงค่าดิบผ่าน `labelOf`
export const ROLE_LABEL: Record<string, string> = {
  STUDENT: 'นักศึกษา',
  COMPANY_HR: 'ฝ่ายบุคคลบริษัท',
  ADVISOR: 'อาจารย์ที่ปรึกษา',
  PLATFORM_ADMIN: 'ผู้ดูแลแพลตฟอร์ม',
};

export const USER_STATUS_LABEL: Record<string, string> = {
  PENDING_EMAIL: 'รอยืนยันอีเมล',
  PENDING_APPROVAL: 'รออนุมัติ',
  ACTIVE: 'ใช้งานอยู่',
  SUSPENDED: 'ถูกระงับ',
  DELETED: 'ลบแล้ว',
};

export const ADVISOR_LINK_LABEL: Record<string, string> = {
  NONE: 'ยังไม่มีอาจารย์ที่ปรึกษา',
  ADVISOR_LINK_PENDING: 'รออาจารย์ยืนยัน',
  LINKED: 'มีอาจารย์ที่ปรึกษาแล้ว',
};

/** Audit log ของ Identity — ชื่อการกระทำที่ Identity บันทึก (apps/identity: admin, companies, company-members, advisor-links) */
export const IDENTITY_AUDIT_ACTION_LABEL: Record<string, string> = {
  COMPANY_VERIFY: 'อนุมัติบริษัท',
  COMPANY_NEED_MORE_INFO: 'ขอเอกสารบริษัทเพิ่ม',
  COMPANY_REJECT: 'ปฏิเสธบริษัท',
  COMPANY_SUSPEND: 'ระงับบริษัท',
  COMPANY_UNSUSPEND: 'ยกเลิกระงับบริษัท',
  COMPANY_UNIVERSITY_PARTNER: 'ตั้งค่า University Partner',
  COMPANY_ENTITLEMENTS: 'ตั้งสิทธิ์ Featured / Fast-Track',
  COMPANY_OWNER_APPOINT: 'แต่งตั้ง Owner บริษัท',
  COMPANY_OWNER_TRANSFER: 'โอนสิทธิ์ Owner บริษัท',
  COMPANY_MEMBER_CATEGORIES: 'กำหนดสายงานของสมาชิก HR',
  COMPANY_MEMBER_REMOVE: 'นำสมาชิก HR ออก',
  COMPANY_INVITATION_CANCEL: 'ยกเลิกคำเชิญ HR',
  USER_SUSPEND: 'ระงับบัญชีผู้ใช้',
  USER_UNSUSPEND: 'ยกเลิกระงับบัญชีผู้ใช้',
  ADVISOR_APPROVE: 'อนุมัติอาจารย์',
  ADVISOR_REJECT: 'ปฏิเสธอาจารย์',
  STUDENT_ADVISOR_MOVE: 'ย้ายอาจารย์ที่ปรึกษาของนักศึกษา',
};

export const IDENTITY_AUDIT_TARGET_LABEL: Record<string, string> = {
  COMPANY: 'บริษัท',
  USER: 'ผู้ใช้',
};

export function labelOf(map: Record<string, string>, value: string): string {
  return map[value] ?? value;
}

const UNKNOWN: StatusView ={ label: 'ไม่ทราบสถานะ', tone: 'neutral', icon: Clock5 };

// สถานะที่ยังไม่รู้จัก (เช่น Service เพิ่มค่าใหม่) ต้องไม่ทำให้หน้าพัง — แสดงเป็นป้ายกลาง
export function statusView(map: StatusMap, status: string): StatusView {
  return map[status] ?? UNKNOWN;
}
