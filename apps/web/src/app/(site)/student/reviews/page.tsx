'use client';

import { Suspense } from 'react';
import { RequireAuth } from '@/components/layout/require-auth';
import { ReviewPage } from '@/components/student/review-page';

export default function StudentReviewsPage() {
  return (
    <RequireAuth roles={['STUDENT']}>
      <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <ReviewPage />
      </Suspense>
    </RequireAuth>
  );
}
