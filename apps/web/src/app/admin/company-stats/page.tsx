import { Suspense } from 'react';
import { CompanyStats } from '@/components/admin/lifecycle/company-stats';

export const metadata = { title: 'สถิติบริษัท' };

// `useSearchParams` ต้องอยู่ใน Suspense เพื่อให้หน้าสร้างแบบ static ได้
export default function AdminCompanyStatsPage() {
  return (
    <Suspense fallback={<p className="text-sm text-ink-soft">กำลังโหลด…</p>}>
      <CompanyStats />
    </Suspense>
  );
}
