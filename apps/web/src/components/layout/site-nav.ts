import type { Role } from '@internpath/contracts';

/**
 * เมนูหลักของเว็บ (นอกหน้า Admin ที่มี sidebar ของตัวเอง — ดู components/admin/admin-nav.ts)
 * `ready: false` = หน้ายังไม่มี: ไม่แสดงในเมนู (กันกดแล้วเจอ 404) — เปิดใช้โดยเปลี่ยนเป็น `true` ที่นี่ที่เดียวเมื่อหน้าพร้อม
 * เส้นทางของหน้าที่ยังไม่มีเป็นข้อเสนอ ตามโฟลเดอร์ `student/`, `hr/`, `advisor/` ที่เตรียมไว้ใน apps/web/src/app
 */
export type NavItem = { label: string; href: string; ready: boolean };

export const PUBLIC_NAV: NavItem[] = [
  { label: 'ค้นหางาน', href: '/jobs', ready: true },
  { label: 'บริษัทและรีวิว', href: '/companies', ready: true },
];

export const ROLE_NAV: Record<Role, NavItem[]> = {
  STUDENT: [
    { label: 'ใบสมัครของฉัน', href: '/student/applications', ready: true },
    { label: 'ใบรับรองของฉัน', href: '/student/certificates', ready: true },
    { label: 'รีวิวบริษัท', href: '/student/reviews', ready: true },
    { label: 'โปรไฟล์และเรซูเม่', href: '/student/profile', ready: true },
  ],
  COMPANY_HR: [
    { label: 'ประกาศของฉัน', href: '/hr/jobs', ready: true },
    { label: 'ผู้สมัคร', href: '/hr/applicants', ready: true },
    { label: 'บริษัทของฉัน', href: '/hr/company', ready: true },
    { label: 'รีวิวบริษัท', href: '/hr/reviews', ready: true },
    { label: 'ทีม HR', href: '/hr/team', ready: true },
  ],
  ADVISOR: [
    { label: 'ภาพรวม', href: '/advisor', ready: true },
    { label: 'นักศึกษาของฉัน', href: '/advisor/students', ready: true },
    { label: 'อนุมัติฝึกงาน', href: '/advisor/approvals', ready: true },
    { label: 'ประเมินผล', href: '/advisor/evaluations', ready: true },
    { label: 'รายงานปัญหา', href: '/advisor/problem-reports', ready: true },
  ],
  PLATFORM_ADMIN: [{ label: 'หลังบ้าน', href: '/admin/queue', ready: true }],
};

/** หน้าแรกของแต่ละบทบาท — ใช้พาไปหลังล็อกอินเมื่อไม่มี `?next=` */
export const ROLE_HOME: Record<Role, string> = {
  STUDENT: '/jobs',
  COMPANY_HR: '/hr/jobs',
  ADVISOR: '/advisor',
  PLATFORM_ADMIN: '/admin/queue',
};

export const FOOTER_LINKS: NavItem[] = [
  { label: 'ตรวจสอบใบรับรอง', href: '/public/certificates', ready: true },
  { label: 'นโยบายความเป็นส่วนตัว', href: '/privacy', ready: true },
];
