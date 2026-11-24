'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Hero } from './hero';
import { Avatar } from '@/components/ui/avatar';
import { allowanceLabel } from '@/lib/allowance';
import { JobResultCard } from '@/components/jobs/job-result-card';
import { searchJobs } from '@/lib/job-search';
import type { JobSearchResult } from '@/lib/job-search';

/** "งานเด่น" ของหน้าแรก = `GET /search/jobs?page_size=3` (api-contract §5.2: `featured` ขึ้นก่อนเสมอ แล้วตามประกาศใหม่ล่าสุด) */
const LANDING_SIZE = 3;

export function FeaturedJobs({ children }: { children: ReactNode }) {
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

  const jobs = result?.jobs ?? [];
  const positions = ['relative z-10 w-full max-w-xs', 'absolute left-0 hidden -rotate-6 sm:flex', 'absolute right-0 hidden rotate-6 sm:flex'];

  return (
    <>
      <Hero>
        {jobs.length > 0 && (
          <ul className="relative mx-auto mt-12 flex max-w-3xl items-center justify-center sm:mt-16" aria-label="ตัวอย่างประกาศที่เปิดรับ">
            {jobs.map((job, index) => (
              <li key={job.id} className={`w-72 rounded-xl border border-border bg-surface-pearl ${positions[index]}`}>
                <Link href={`/jobs/item?id=${job.id}`} className="flex min-w-0 items-center gap-3 rounded-xl p-4 text-left hover:text-primary">
                  <Avatar name={job.company.name} src={job.company.logo_url} />
                  <div className="min-w-0">
                    <p className="truncate text-xs text-ink-soft">{job.company.name}</p>
                    <p className="break-words text-base font-semibold">{job.job_title}</p>
                    <p className="mt-1 text-xs text-ink-soft">{allowanceLabel(job.allowance)}</p>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Hero>
      {children}
      <section aria-labelledby="jobs-title" className="bg-surface-muted px-4 py-16 sm:py-20">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="jobs-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-tight">งานฝึกงานที่เปิดรับตอนนี้</h2>
            <Link href="/jobs" className="text-primary hover:underline">ดูทั้งหมด ›</Link>
          </div>
          {failed && <p className="mt-8 text-sm text-ink-soft">โหลดประกาศไม่สำเร็จ กรุณาลองใหม่ภายหลัง</p>}
          {!result && !failed && <p role="status" className="mt-8 text-sm text-ink-soft">กำลังโหลด…</p>}
          {result && (jobs.length === 0
            ? <p className="mt-8 text-sm text-ink-soft">ยังไม่มีประกาศที่เปิดรับ</p>
            : <ul className="mt-8 grid gap-5 md:grid-cols-3">
                {jobs.map((job) => (
                  <li key={job.id} className="contents"><JobResultCard job={job} rating={result.ratings[job.company.id]} /></li>
                ))}
              </ul>)}
        </div>
      </section>
    </>
  );
}
