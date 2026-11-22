/**
 * เมนู Admin จัดกลุ่มตาม Service เจ้าของ (README §11) — เจ้าของแต่ละ Service เสียบหน้าของตนโดยเพิ่มรายการที่นี่
 * `href` เป็น null = ยังไม่มีหน้า (ไม่แสดงในเมนู — เจ้าของใส่ path เมื่อหน้าพร้อม)
 */
export type AdminNavItem = { label: string; href: string | null };
export type AdminNavGroup = { title: string; owner: string; items: AdminNavItem[] };

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    title: 'ตรวจสอบและความไว้วางใจ', owner: 'PM',
    items: [
      { label: 'คิวตรวจ', href: '/admin/queue' },
      { label: 'ธงบริษัท', href: '/admin/flags' },
      { label: 'Audit log', href: '/admin/audit' },
    ],
  },
  {
    title: 'บัญชีและองค์กร', owner: 'SA',
    items: [
      { label: 'บริษัท', href: '/admin/companies' },
      { label: 'อาจารย์ที่ปรึกษา', href: '/admin/advisors' },
      { label: 'ผู้ใช้', href: '/admin/users' },
      { label: 'Audit log (Identity)', href: '/admin/identity-audit' },
    ],
  },
  {
    title: 'ใบสมัครและใบรับรอง', owner: 'Tester',
    items: [
      { label: 'ใบสมัครที่รอดำเนินการ', href: '/admin/applications' },
      { label: 'รายงานปัญหา', href: null },
      { label: 'ใบรับรอง', href: '/admin/certificates' },
    ],
  },
  {
    title: 'ประกาศงาน', owner: 'JR',
    items: [
      { label: 'ประกาศทุกสถานะ', href: '/admin/jobs' },
      { label: 'Tag ทักษะ', href: '/admin/tags' },
    ],
  },
];
