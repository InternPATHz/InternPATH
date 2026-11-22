import type { JobCategory } from '@internpath/contracts';

/** สายงาน 3 หมวดของประกาศ (README 5.1) — ใช้ทั้งตัวกรองค้นหา หน้าแรก และฝั่ง HR */
export const CATEGORIES: Array<{ id: JobCategory; label: string; description: string }> = [
  { id: 'TECH_IT', label: 'Tech & IT', description: 'ซอฟต์แวร์ · ข้อมูล · UX' },
  { id: 'BUSINESS_MARKETING', label: 'Business & Marketing', description: 'การตลาด · คอนเทนต์ · ธุรกิจ' },
  { id: 'CORPORATE_SERVICES', label: 'Corporate Services', description: 'บุคคล · บริการ · ธุรการ' },
];
