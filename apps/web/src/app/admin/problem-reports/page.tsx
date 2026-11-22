import { Suspense } from 'react';
import { AdminProblemReports } from '@/components/admin/lifecycle/admin-problem-reports';

export const metadata = { title: 'รายงานปัญหาระหว่างฝึกงาน — InternPath Admin' };

// `useSearchParams` ต้องอยู่ใน Suspense เพื่อให้หน้าสร้างแบบ static ได้
export default function AdminProblemReportsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <AdminProblemReports />
    </Suspense>
  );
}
