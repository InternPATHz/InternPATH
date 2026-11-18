'use client';

import { Suspense } from 'react';
import { RequireAuth } from '@/components/layout/require-auth';
import { ApplicationList } from '@/components/student/application-list';

export default function StudentApplicationsPage() {
  return (
    <RequireAuth roles={['STUDENT']}>
      <Suspense fallback={<main className="mx-auto max-w-4xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <ApplicationList />
      </Suspense>
    </RequireAuth>
  );
}
