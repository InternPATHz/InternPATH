import { RequireAuth } from '@/components/layout/require-auth';
import { HrOverview } from '@/components/hr/hr-overview';

export const metadata = { title: 'ภาพรวมบริษัท' };

export default function HrPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <HrOverview />
    </RequireAuth>
  );
}
