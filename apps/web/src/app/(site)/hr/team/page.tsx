'use client';

import { TeamPage } from '@/components/hr/team/team-page';
import { RequireAuth } from '@/components/layout/require-auth';

export default function HrTeamPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <TeamPage />
    </RequireAuth>
  );
}
