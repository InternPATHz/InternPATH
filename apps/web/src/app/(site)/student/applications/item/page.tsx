'use client';

import { Suspense } from 'react';
import { RequireAuth } from '@/components/layout/require-auth';
import { ApplicationDetail } from '@/components/student/application-detail';

// ใช้ query `?id=` แทนเส้นทางไดนามิก เพื่อให้ส่งออกเป็น static ได้ (README §4.4)
export default function StudentApplicationItemPage() {
  return (
    <RequireAuth roles={['STUDENT']}>
      <Suspense fallback={<main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
        <ApplicationDetail />
      </Suspense>
    </RequireAuth>
  );
}
