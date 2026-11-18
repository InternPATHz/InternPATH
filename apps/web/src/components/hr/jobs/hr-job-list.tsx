'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { HrJobObject, JobStatus, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { JobStatusBadge, WORK_MODE_LABEL, formatDay, jobTitleOf } from '@/components/hr/jobs/job-ui';
import { ApiError } from '@/lib/api';
import { HR_JOBS_MOCK, hrJobsApi } from '@/lib/hr-jobs';
import { JOB_STATUS } from '@/lib/status-map';

const QUICK: Array<[string, JobStatus | '']> = [
  ['ทั้งหมด', ''], ['ร่าง', 'DRAFT'], ['กำลังตรวจสอบ', 'VERIFYING'], ['เปิดรับสมัคร', 'PUBLISHED'], ['ถูกตีกลับ', 'AUTO_REJECTED'], ['ปิดแล้ว', 'CLOSED'],
];

export function HrJobList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const api = useMemo(() => hrJobsApi(request), [request]);
  const statusParam = searchParams.get('status') ?? '';
  const status = statusParam in JOB_STATUS ? (statusParam as JobStatus) : undefined;

  const [result, setResult] = useState<Paginated<HrJobObject> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    api.list(status).then(
      (data) => { if (!cancelled) setResult(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดรายการประกาศไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [api, status]);

  function filter(value: string) {
    router.replace(value ? `${pathname}?status=${value}` : pathname, { scroll: false });
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">ประกาศของฉัน</h1>
          <p className="mt-2 text-sm text-ink-soft">สร้าง แก้ไข ส่งตรวจ และปิดประกาศรับนักศึกษาฝึกงานของบริษัท</p>
          {HR_JOBS_MOCK && <p className="mt-1 text-xs text-warning-text">ข้อมูลในหน้านี้เป็นข้อมูลจำลอง</p>}
        </div>
        <Link href="/hr/jobs/form" className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">สร้างประกาศใหม่</Link>
      </div>

      <div role="group" aria-label="กรองตามสถานะ" className="mt-6 flex flex-wrap gap-2">
        {QUICK.map(([label, value]) => (
          <button key={label} type="button" onClick={() => filter(value)} aria-pressed={(status ?? '') === value}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium ${(status ?? '') === value ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
            {label}
          </button>
        ))}
      </div>

      <section aria-busy={!result && !error} className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {result && result.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">{status ? 'ไม่มีประกาศในสถานะนี้' : 'ยังไม่มีประกาศ'}</p>
            <Link href="/hr/jobs/form" className="mt-2 inline-block text-sm font-medium text-primary hover:underline">สร้างประกาศแรก</Link>
          </div>
        )}
        {result && result.data.length > 0 && (
          <ul className="space-y-3">
            {result.data.map((job) => (
              <li key={job.id} className="rounded-xl border border-border bg-surface p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{jobTitleOf(job)}</h2>
                    <p className="text-sm text-ink-soft">
                      {[job.work_mode ? WORK_MODE_LABEL[job.work_mode] : null, job.location].filter(Boolean).join(' · ') || 'ยังไม่ระบุสถานที่'}
                    </p>
                  </div>
                  <JobStatusBadge status={job.status} />
                </div>
                <p className="mt-3 text-xs text-ink-soft">
                  {job.quota !== null ? `โควตา ${job.quota} ตำแหน่ง` : 'ยังไม่ระบุโควตา'}
                  {job.application_deadline && ` · ปิดรับสมัคร ${formatDay(job.application_deadline)}`}
                  {job.featured && ' · Featured'}
                </p>
                <Link href={`/hr/jobs/item?id=${job.id}`} className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">ดูรายละเอียด</Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
