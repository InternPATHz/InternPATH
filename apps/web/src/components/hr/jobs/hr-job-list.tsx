'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { HrJobObject, JobStatus, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { JobStatusBadge, WORK_MODE_LABEL, formatDay, jobTitleOf } from '@/components/hr/jobs/job-ui';
import { ApiError } from '@/lib/api';
import { HR_JOBS_PAGE_SIZE, hrJobsApi } from '@/lib/hr-jobs';
import { JOB_STATUS } from '@/lib/status-map';

const QUICK: Array<[string, JobStatus | '']> = [
  ['ทั้งหมด', ''], ['ร่าง', 'DRAFT'], ['รอ Admin ตรวจ', 'PENDING_REVIEW'], ['เปิดรับสมัคร', 'PUBLISHED'], ['ถูกตีกลับ', 'ADMIN_REJECTED'], ['ปิดแล้ว', 'CLOSED'],
];

type PageState = { key: string } & (
  { result: Paginated<HrJobObject>; error?: never } | { error: string; result?: never }
);

export function HrJobList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const api = useMemo(() => hrJobsApi(request), [request]);
  const statusParam = searchParams.get('status') ?? '';
  const status = Object.hasOwn(JOB_STATUS, statusParam) ? (statusParam as JobStatus) : undefined;
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 && pageParam <= 2147483647 ? pageParam : 1;
  const key = `${status ?? ''}:${page}`;
  const [state, setState] = useState<PageState>();
  const { result, error } = state?.key === key ? state : {};
  const total = result?.meta.total ?? 0;
  const pageCount = result ? Math.max(1, Math.ceil(total / result.meta.page_size)) : 1;

  useEffect(() => {
    let cancelled = false;
    api.list(status, page, HR_JOBS_PAGE_SIZE).then(
      (data) => { if (!cancelled) setState({ key, result: data }); },
      (cause) => { if (!cancelled) setState({ key, error: cause instanceof ApiError ? cause.message : 'โหลดรายการประกาศไม่สำเร็จ กรุณาลองใหม่' }); },
    );
    return () => { cancelled = true; };
  }, [api, status, page, key]);

  function navigate(value: JobStatus | '', targetPage: number) {
    const query = new URLSearchParams();
    if (value) query.set('status', value);
    if (targetPage > 1) query.set('page', String(targetPage));
    router.replace(query.size ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">ประกาศของฉัน</h1>
          <p className="mt-2 text-sm text-ink-soft">สร้าง แก้ไข เผยแพร่ และปิดประกาศรับนักศึกษาฝึกงานของบริษัท</p>
        </div>
        <Link href="/hr/jobs/form" className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover">สร้างประกาศใหม่</Link>
      </div>

      {!!result?.data.length && (
        <dl className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-3" aria-label="สรุปประกาศในหน้านี้">
          {[
            ['เปิดรับในหน้านี้', result.data.filter((job) => job.status === 'PUBLISHED').length],
            ['ตำแหน่งว่างในหน้านี้', result.data.filter((job) => job.status === 'PUBLISHED').reduce((sum, job) => sum + (job.quota_available ?? 0), 0)],
            ['ถูกตีกลับในหน้านี้', result.data.filter((job) => job.status === 'ADMIN_REJECTED').length],
          ].map(([label, count]) => (
            <div key={label} className="rounded-xl bg-surface-muted p-4">
              <dt className="text-sm text-ink-soft">{label}</dt>
              <dd className="mt-1 text-3xl font-semibold tabular-nums">{count}</dd>
            </div>
          ))}
        </dl>
      )}
      <div role="group" aria-label="กรองตามสถานะ" className="mt-6 flex flex-wrap gap-2">
        {QUICK.map(([label, value]) => (
          <button key={label} type="button" onClick={() => { if ((status ?? '') !== value) navigate(value, 1); }} aria-pressed={(status ?? '') === value}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium ${(status ?? '') === value ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
            {label}
          </button>
        ))}
      </div>

      <section aria-busy={!result && !error} className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {result && <p role="status" className="mb-3 text-sm text-ink-soft">ทั้งหมด {total} ประกาศ · หน้า {page} จาก {pageCount}</p>}
        {result && result.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">{total > 0 ? 'ไม่มีประกาศในหน้านี้' : status ? 'ไม่มีประกาศในสถานะนี้' : 'ยังไม่มีประกาศ'}</p>
            {total === 0 && <Link href="/hr/jobs/form" className="mt-2 inline-block text-sm font-medium text-primary hover:underline">สร้างประกาศแรก</Link>}
          </div>
        )}
        {result && (pageCount > 1 || page > 1) && (
          <nav aria-label="หน้ารายการประกาศ" className="mt-6 flex justify-between gap-3">
            <button type="button" disabled={page === 1} onClick={() => navigate(status ?? '', Math.min(page - 1, pageCount))}
              className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-50">หน้าก่อนหน้า</button>
            <button type="button" disabled={page >= pageCount} onClick={() => navigate(status ?? '', page + 1)}
              className="rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-50">หน้าถัดไป</button>
          </nav>
        )}
        {result && result.data.length > 0 && (
          <ul className="space-y-3 md:hidden">
            {result.data.map((job) => (
              <li key={job.id} className={`rounded-xl border border-border bg-surface p-5 ${job.status === 'ADMIN_REJECTED' ? 'border-l-4 border-l-danger' : ''}`}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 [overflow-wrap:anywhere]">
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
        {!!result?.data.length && (
          <div className="hidden overflow-x-auto rounded-xl border border-border md:block">
            <table className="w-full min-w-[650px] text-left text-sm">
              <thead className="bg-surface-muted">
                <tr>
                  <th scope="col" className="p-4">ประกาศ</th>
                  <th scope="col" className="p-4">สถานะ</th>
                  <th scope="col" className="p-4">ตำแหน่ง</th>
                  <th scope="col" className="p-4">ปิดรับสมัคร</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {result.data.map((job) => (
                  <tr key={job.id}>
                    <th scope="row" className={`border-l-4 p-4 font-medium ${job.status === 'ADMIN_REJECTED' ? 'border-l-danger' : 'border-l-transparent'}`}>
                      <Link href={`/hr/jobs/item?id=${job.id}`} className="text-primary hover:underline">{jobTitleOf(job)}</Link>
                      {job.location && <span className="mt-1 block text-xs text-ink-soft">{job.location}</span>}
                    </th>
                    <td className="p-4"><JobStatusBadge status={job.status} /></td>
                    <td className="p-4">
                      {job.quota === null || job.quota_available === null ? '–' : <>
                        <span>{job.quota_available} / {job.quota} ว่าง</span>
                        {job.quota > 0 && <meter className="mt-1 block h-2 w-20" min={0} max={job.quota} value={job.quota_available} aria-label="ตำแหน่งว่าง" />}
                      </>}
                    </td>
                    <td className="p-4">{job.application_deadline ? formatDay(job.application_deadline) : '–'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
