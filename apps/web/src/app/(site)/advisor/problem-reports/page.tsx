'use client';

import { Suspense } from 'react';
import { AdvisorProblemReports } from '@/components/advisor/advisor-problem-reports';
import { RequireAuth } from '@/components/layout/require-auth';

export default function AdvisorProblemReportsPage() {
  return (
    <RequireAuth roles={['ADVISOR']}>
      <Suspense fallback={<p className="p-8 text-sm text-ink-soft">กำลังโหลด…</p>}>
        <AdvisorProblemReports />
      </Suspense>
    </RequireAuth>
  );
}
