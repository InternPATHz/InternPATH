'use client';

import { Suspense } from 'react';
import { AdvisorConductReports } from '@/components/advisor/advisor-conduct-reports';
import { RequireAuth } from '@/components/layout/require-auth';

export default function AdvisorConductReportsPage() {
  return (
    <RequireAuth roles={['ADVISOR']}>
      <Suspense fallback={<p className="p-8 text-sm text-ink-soft">กำลังโหลด…</p>}>
        <AdvisorConductReports />
      </Suspense>
    </RequireAuth>
  );
}
