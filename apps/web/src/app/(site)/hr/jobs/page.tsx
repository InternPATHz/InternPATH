'use client';

import { Suspense } from 'react';
import { HrJobList } from '@/components/hr/jobs/hr-job-list';
import { RequireAuth } from '@/components/layout/require-auth';

export default function HrJobsPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <Suspense fallback={<main className="mx-auto max-w-5xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <HrJobList />
      </Suspense>
    </RequireAuth>
  );
}
