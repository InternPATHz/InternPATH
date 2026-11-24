import { Suspense } from 'react';
import { RequireAuth } from '@/components/layout/require-auth';
import { AdvisorStudentDetail } from '@/components/advisor/advisor-student-detail';

export const metadata = { title: 'รายละเอียดนักศึกษา' };

export default function AdvisorStudentPage() {
  return (
    <RequireAuth roles={['ADVISOR']}>
      <Suspense fallback={<p className="p-8 text-sm text-ink-soft">กำลังโหลด…</p>}>
        <AdvisorStudentDetail />
      </Suspense>
    </RequireAuth>
  );
}
