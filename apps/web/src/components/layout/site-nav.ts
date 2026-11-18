import type { Role } from '@internpath/contracts';

/**
 * เมนูหลักของเว็บ (นอกหน้า Admin ที่มี sidebar ของตัวเอง — ดู components/admin/admin-nav.ts)
 * `ready: false` = หน้ายังไม่มี: แสดงเป็นข้อความสีจางไม่ลิงก์ (กันกดแล้วเจอ 404) — เปิดใช้โดยเปลี่ยนเป็น `true` ที่นี่ที่เดียวเมื่อหน้าพร้อม
 * เส้นทางของหน้าที่ยังไม่มีเป็นข้อเสนอ ตามโฟลเดอร์ `student/`, `hr/`, `advisor/` ที่เตรียมไว้ใน apps/web/src/app
 */
export type NavItem = { label: string; href: string; ready: boolean };

export const PUBLIC_NAV: NavItem[] = [
  { label: 'ค้นหางาน', href: '/jobs', ready: true },
  { label: 'บริษัทและรีวิว', href: '/companies', ready: false },
];

export const ROLE_NAV: Record<Role, NavItem[]> = {
  STUDENT: [
    { label: 'ใบสมัครของฉัน', href: '/student/applications', ready: true },
    { label: 'โปรไฟล์และเรซูเม่', href: '/student/profile', ready: true },
  ],
  COMPANY_HR: [
    { label: 'ประกาศของฉัน', href: '/hr/jobs', ready: false },
    { label: 'ผู้สมัคร', href: '/hr/applicants', ready: true },
  ],
  ADVISOR: [{ label: 'คำขออนุมัติ', href: '/advisor/requests', ready: false }],
  PLATFORM_ADMIN: [{ label: 'หลังบ้าน', href: '/admin/queue', ready: true }],
};

export const FOOTER_LINKS: NavItem[] = [
  { label: 'นโยบายความเป็นส่วนตัว', href: '/privacy', ready: true },
];
