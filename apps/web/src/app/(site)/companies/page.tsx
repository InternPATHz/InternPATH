import { Suspense } from 'react';
import { CompanyList } from '@/components/companies/company-list';

export const metadata = { title: 'บริษัทและรีวิว' };

export default function CompaniesPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-6xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
      <CompanyList />
    </Suspense>
  );
}
