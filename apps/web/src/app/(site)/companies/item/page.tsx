import { Suspense } from 'react';
import { CompanyDetail } from '@/components/companies/company-detail';

export const metadata = { title: 'ข้อมูลบริษัทและรีวิว' };

// ใช้ query `?id=` แทนเส้นทางไดนามิก เพื่อส่งออกเป็น static ได้ (README §4.4)
export default function CompanyItemPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
      <CompanyDetail />
    </Suspense>
  );
}
