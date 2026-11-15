/**
 * เมนู Admin จัดกลุ่มตาม Service เจ้าของ (README §11) — เจ้าของแต่ละ Service เสียบหน้าของตนโดยเพิ่มรายการที่นี่
 * `href` เป็น null = ยังไม่มีหน้า (แสดงเป็น "เร็ว ๆ นี้")
 */
export type AdminNavItem = { label: string; href: string | null };
export type AdminNavGroup = { title: string; owner: string; items: AdminNavItem[] };

export const ADMIN_NAV: AdminNavGroup[] = [
  {
    title: 'ตรวจสอบและความไว้วางใจ', owner: 'PM',
    items: [
      { label: 'คิวตรวจ', href: '/admin/queue' },
      { label: 'ธงบริษัท', href: '/admin/flags' },
      { label: 'Blacklist', href: '/admin/blacklist' },
      { label: 'Risk Rules', href: null },
      { label: 'Audit log', href: null },
    ],
  },
  {
    title: 'บัญชีและองค์กร', owner: 'SA',
    items: [
      { label: 'บริษัท', href: null },
      { label: 'อาจารย์ที่ปรึกษา', href: null },
      { label: 'ผู้ใช้', href: null },
    ],
  },
  {
    title: 'ใบสมัครและใบรับรอง', owner: 'Tester',
    items: [
      { label: 'ใบสมัครที่รอดำเนินการ', href: null },
      { label: 'รายงานปัญหา', href: null },
      { label: 'ใบรับรอง', href: null },
    ],
  },
  {
    title: 'ประกาศงาน', owner: 'JR',
    items: [{ label: 'ประกาศทุกสถานะ', href: null }],
  },
];
