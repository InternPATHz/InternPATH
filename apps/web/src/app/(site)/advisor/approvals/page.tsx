'use client';

import { Suspense } from 'react';
import { AdvisorApprovals } from '@/components/advisor/advisor-approvals';
import { RequireAuth } from '@/components/layout/require-auth';

export default function AdvisorApprovalsPage() {
  return (
    <RequireAuth roles={['ADVISOR']}>
      <Suspense fallback={<p className="p-8 text-sm text-ink-soft">กำลังโหลด…</p>}>
        <AdvisorApprovals />
      </Suspense>
    </RequireAuth>
  );
}
