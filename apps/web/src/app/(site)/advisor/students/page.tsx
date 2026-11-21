'use client';

import { Suspense } from 'react';
import { AdvisorStudents } from '@/components/advisor/advisor-students';
import { RequireAuth } from '@/components/layout/require-auth';

export default function AdvisorStudentsPage() {
  return (
    <RequireAuth roles={['ADVISOR']}>
      <Suspense fallback={<p className="p-8 text-sm text-ink-soft">กำลังโหลด…</p>}>
        <AdvisorStudents />
      </Suspense>
    </RequireAuth>
  );
}
