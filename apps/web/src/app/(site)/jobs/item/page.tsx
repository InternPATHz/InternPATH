import { Suspense } from 'react';
import { JobDetail } from '@/components/jobs/job-detail';

export const metadata = { title: 'รายละเอียดงานฝึกงาน' };

// ใช้ query `?id=` แทนเส้นทางไดนามิก เพื่อให้ส่งออกเป็น static ได้ตามแผนสาธิต (README §4.4) — เหมือนหน้ารายการคิวของ Admin
export default function JobItemPage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-4xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
      <JobDetail />
    </Suspense>
  );
}
