import type { ReactNode } from 'react';
import { AdminShell } from '@/components/admin/admin-shell';

// absolute: ไม่ต่อ " · InternPath" จาก layout ราก • หน้า Admin ตั้งแค่ชื่อหน้า แล้วได้ "คิวตรวจ · InternPath Admin"
export const metadata = { title: { absolute: 'InternPath Admin', template: '%s · InternPath Admin' } };

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
