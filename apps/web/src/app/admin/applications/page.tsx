import { Suspense } from 'react';
import { NoEvaluationList } from '@/components/admin/lifecycle/no-evaluation-list';

export const metadata = { title: 'ใบสมัครที่บริษัทไม่ประเมินผล — InternPath Admin' };

// `useSearchParams` ต้องอยู่ใน Suspense เพื่อให้หน้าสร้างแบบ static ได้
export default function AdminApplicationsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <NoEvaluationList />
    </Suspense>
  );
}
