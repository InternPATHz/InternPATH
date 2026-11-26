import {
  Award,
  Briefcase,
  Building2,
  ChartColumn,
  FileText,
  Flag,
  GraduationCap,
  Inbox,
  Landmark,
  ScrollText,
  Tags,
  TriangleAlert,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * ไอคอนหน้าเมนู Admin เป็นเรื่องหน้าตาเท่านั้น จึงแยกจาก `admin-nav.ts` (สัญญาที่เจ้าของ Service แก้ร่วมกัน)
 * จับคู่ด้วย `label` ของรายการ — รายการที่ไม่อยู่ในแมปแสดงโดยไม่มีไอคอน ไม่ทำให้หน้าพัง
 */
export const ADMIN_NAV_ICONS: Record<string, LucideIcon> = {
  'คิวตรวจ': Inbox,
  'จัดการธงบริษัท': Flag,
  'บันทึกการดำเนินการ': ScrollText,
  'บริษัท': Building2,
  'อาจารย์ที่ปรึกษา': GraduationCap,
  'ผู้ใช้': Users,
  'มหาวิทยาลัย': Landmark,
  'Audit log (Identity)': ScrollText,
  'ใบสมัครที่รอดำเนินการ': FileText,
  'รายงานปัญหา': TriangleAlert,
  'ใบรับรอง': Award,
  'สถิติบริษัท': ChartColumn,
  'Audit log (Lifecycle)': ScrollText,
  'ประกาศทุกสถานะ': Briefcase,
  'Tag ทักษะ': Tags,
};
