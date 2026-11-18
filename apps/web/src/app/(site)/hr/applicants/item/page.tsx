'use client';

import { Suspense } from 'react';
import { ApplicantDetail } from '@/components/hr/applicant-detail';
import { RequireAuth } from '@/components/layout/require-auth';

// ใช้ query `?id=` แทนเส้นทางไดนามิก เพื่อให้ส่งออกเป็น static ได้ (README §4.4)
export default function HrApplicantItemPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <ApplicantDetail />
      </Suspense>
    </RequireAuth>
  );
}
