import { Suspense } from 'react';
import { JobSearchPage } from '@/components/jobs/job-search-page';

export const metadata = { title: 'ค้นหางานฝึกงาน' };

// `useSearchParams` ต้องอยู่ใน Suspense เพื่อให้หน้าสร้างแบบ static ได้
export default function JobsPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-6xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
      <JobSearchPage />
    </Suspense>
  );
}
