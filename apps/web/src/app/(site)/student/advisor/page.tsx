'use client';

import { RequireAuth } from '@/components/layout/require-auth';
import { AdvisorLink } from '@/components/student/advisor-link';

export default function StudentAdvisorPage() {
  return (
    <RequireAuth roles={['STUDENT']}>
      <AdvisorLink />
    </RequireAuth>
  );
}
