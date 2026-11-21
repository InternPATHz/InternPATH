'use client';

import { useEffect, useState } from 'react';
import { JobResultCard } from '@/components/jobs/job-result-card';
import { searchJobs } from '@/lib/job-search';
import type { JobSearchResult } from '@/lib/job-search';

/** "งานเด่น" ของหน้าแรก = `GET /search/jobs?page_size=3` (api-contract §5.2: `featured` ขึ้นก่อนเสมอ แล้วตามประกาศใหม่ล่าสุด) */
const LANDING_SIZE = 3;

export function FeaturedJobs() {
  const [result, setResult] = useState<JobSearchResult | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    searchJobs({ sort: 'newest' }, 1, LANDING_SIZE).then(
      (next) => { if (!cancelled) setResult(next); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, []);

  if (failed) return <p className="mt-8 text-sm text-ink-soft">โหลดประกาศไม่สำเร็จ กรุณาลองใหม่ภายหลัง</p>;
  if (!result) return <p className="mt-8 text-sm text-ink-soft" aria-busy="true">กำลังโหลด…</p>;
  if (result.jobs.length === 0) return <p className="mt-8 text-sm text-ink-soft">ยังไม่มีประกาศที่เปิดรับ</p>;
  return (
    <ul className="mt-8 grid gap-5 md:grid-cols-3">
      {result.jobs.map((job) => (
        <li key={job.id} className="contents"><JobResultCard job={job} rating={result.ratings[job.company.id]} /></li>
      ))}
    </ul>
  );
}
