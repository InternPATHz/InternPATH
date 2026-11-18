'use client';

import { CompanyPage } from '@/components/hr/company/company-page';
import { RequireAuth } from '@/components/layout/require-auth';

export default function HrCompanyPage() {
  return (
    <RequireAuth roles={['COMPANY_HR']}>
      <CompanyPage />
    </RequireAuth>
  );
}
