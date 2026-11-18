'use client';

import { Suspense } from 'react';
import { HrJobDetail } from '@/components/hr/jobs/hr-job-detail';
import { RequireAuth } from '@/components/layout/require-auth';

// ใช้ query `?id=` แทนเส้นทางไดนามิก เพื่อส่งออกเป็น static ได้ (README §4.4)
export default function HrJobItemPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <HrJobDetail />
      </Suspense>
    </RequireAuth>
  );
}
