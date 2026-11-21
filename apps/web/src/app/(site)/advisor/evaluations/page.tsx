'use client';

import { Suspense } from 'react';
import { AdvisorEvaluations } from '@/components/advisor/advisor-evaluations';
import { RequireAuth } from '@/components/layout/require-auth';

export default function AdvisorEvaluationsPage() {
  return (
    <RequireAuth roles={['ADVISOR']}>
      <Suspense fallback={<p className="p-8 text-sm text-ink-soft">กำลังโหลด…</p>}>
        <AdvisorEvaluations />
      </Suspense>
    </RequireAuth>
  );
}
