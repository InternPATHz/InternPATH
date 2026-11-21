import {
  Award,
  Briefcase,
  Building2,
  FileText,
  Flag,
  GraduationCap,
  Inbox,
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
  'ธงบริษัท': Flag,
  'Audit log': ScrollText,
  'บริษัท': Building2,
  'อาจารย์ที่ปรึกษา': GraduationCap,
  'ผู้ใช้': Users,
  'ใบสมัครที่รอดำเนินการ': FileText,
  'รายงานปัญหา': TriangleAlert,
  'ใบรับรอง': Award,
  'ประกาศทุกสถานะ': Briefcase,
  'Tag ทักษะ': Tags,
};
