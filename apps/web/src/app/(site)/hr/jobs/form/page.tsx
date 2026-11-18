'use client';

import { Suspense } from 'react';
import { HrJobForm } from '@/components/hr/jobs/hr-job-form';
import { RequireAuth } from '@/components/layout/require-auth';

// สร้างใหม่ = ไม่มี `?id=` แก้ไข = `?id=` (ใช้ query แทนเส้นทางไดนามิก เพื่อส่งออกเป็น static ได้ — README §4.4)
export default function HrJobFormPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <HrJobForm />
      </Suspense>
    </RequireAuth>
  );
}
