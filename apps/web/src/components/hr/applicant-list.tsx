'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ApplicantDetail } from './applicant-detail';
import type { ApplicationStatus, HrApplicationItem, Paginated } from '@internpath/contracts';
import type { HrJobObject } from '@internpath/contracts';
import { jobTitleOf } from '@/components/hr/jobs/job-ui';
import { allPages } from '@/lib/list';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ApplicationStatusBadge, formatDate } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';
import { APPLICATION_STATUS } from '@/lib/status-map';

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// กลุ่มสถานะที่ HR มักเปิดดู (ทางลัดของตัวกรองสถานะ) — ค่าอื่นเลือกจากรายการเต็ม
const QUICK_FILTERS: Array<[string, ApplicationStatus | '']> = [
  ['ทั้งหมด', ''],
  ['รอพิจารณา', 'PENDING'],
  ['รอนักศึกษายืนยัน', 'HR_ACCEPTED'],
  ['รอยืนยันเริ่มงาน', 'ADVISOR_APPROVED'],
  ['กำลังฝึกงาน', 'IN_PROGRESS'],
];

export function ApplicantList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const [jobs, setJobs] = useState<HrJobObject[]>([]);
  const [jobsError, setJobsError] = useState(false);
  const [retryJobs, setRetryJobs] = useState(0);
  useEffect(() => {
    let active = true;
    allPages((page) => request<Paginated<HrJobObject>>(`/hr/jobs?page=${page}&page_size=100`)).then(
      (all) => { if (active) { setJobs(all); setJobsError(false); } },
      () => { if (active) setJobsError(true); },
    );
    return () => { active = false; };
  }, [request, retryJobs]);
  const statusParam = searchParams.get('status') ?? '';
  const status = Object.hasOwn(APPLICATION_STATUS, statusParam) ? (statusParam as ApplicationStatus) : undefined;
  const jobParam = searchParams.get('job_id') ?? '';
  const jobId = UUID.test(jobParam) ? jobParam : undefined;
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const [result, setResult] = useState<Paginated<HrApplicationItem> | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [refresh, setRefresh] = useState(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (status) query.set('status', status);
    if (jobId) query.set('job_id', jobId);
    request<Paginated<HrApplicationItem>>(`/hr/applications?${query}`).then(
      (data) => { if (!cancelled) setResult(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดรายการผู้สมัครไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, status, jobId, page, refresh]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const update = () => setShowDetails(desktop.matches);
    update();
    desktop.addEventListener('change', update);
    return () => desktop.removeEventListener('change', update);
  }, []);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) { if (value) next.set(name, value); else next.delete(name); }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    if (qs === searchParams.toString()) return;
    setSelectedId(null);
    setResult(null);
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const selected = result?.data.find((app) => app.id === selectedId) ?? result?.data[0];
  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ผู้สมัครของบริษัท</h1>
      <p className="mt-2 text-sm text-ink-soft">พิจารณาใบสมัคร ส่งข้อเสนอ และติดตามผู้ฝึกงาน</p>

      <div className="mt-6 flex flex-wrap items-end gap-4">
        <div role="group" aria-label="ทางลัดสถานะ" className="flex flex-wrap gap-2">
          {QUICK_FILTERS.map(([label, value]) => (
            <button key={label} type="button" onClick={() => update({ status: value || undefined })} aria-pressed={(status ?? '') === value}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium ${(status ?? '') === value ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
              {label}
            </button>
          ))}
        </div>
        <FilterSelect
          label="สถานะอื่น" value={status ?? ''} onChange={(value) => update({ status: value || undefined })}
          options={[['', 'ทุกสถานะ'], ...Object.entries(APPLICATION_STATUS).map(([value, view]): [string, string] => [value, view.label])]}
        />
        <FilterSelect label="ประกาศ" value={jobId ?? ''} onChange={(value) => update({ job_id: value || undefined })}
          options={[['', 'ทุกประกาศ'], ...(jobId && !jobs.some((job) => job.id === jobId) ? [[jobId, 'ประกาศที่เลือก'] as [string,string]] : []), ...jobs.map((job): [string,string] => [job.id, jobTitleOf(job)])]} />
        {jobsError && <button className="text-sm text-primary" onClick={() => setRetryJobs((n) => n + 1)}>โหลดรายชื่อประกาศอีกครั้ง</button>}
      </div>

      <section aria-busy={!result && !error} className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {result && result.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">{status || jobId ? 'ไม่มีผู้สมัครตามเงื่อนไขนี้' : 'ยังไม่มีผู้สมัคร'}</p>
          </div>
        )}
        {result && result.data.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
            <ul className="min-w-0 divide-y divide-border self-start overflow-hidden [overflow-wrap:anywhere] rounded-xl border border-border bg-surface">
              {result.data.map((app) => {
                const name = app.student_name || 'ไม่พบข้อมูลชื่อ';
                const summary = (
                  <>
                    <span className="block break-words text-base font-semibold">{name}</span>
                    <span className="mt-1 block text-sm text-ink-soft">{app.job_title}</span>
                    <span className="mt-2 flex flex-wrap items-center gap-2">
                      <ApplicationStatusBadge status={app.status} />
                      <span className="text-xs text-ink-soft">{formatDate(app.created_at)}</span>
                    </span>
                    {app.major_mismatch && <span className="mt-2 block text-xs text-warning-text">สาขาไม่ตรงกับประกาศ</span>}
                    {app.frozen && <span className="mt-1 block text-xs text-ink-soft">ประกาศถูกระงับชั่วคราว</span>}
                  </>
                );
                return (
                  <li key={app.id}>
                    <Link href={`/hr/applicants/item?id=${app.id}`} className="block p-4 hover:bg-surface-muted lg:hidden">{summary}</Link>
                    <button type="button" aria-pressed={selected?.id === app.id} onClick={() => setSelectedId(app.id)}
                      className={`hidden w-full p-4 text-left lg:block ${selected?.id === app.id ? 'bg-primary-soft' : 'hover:bg-surface-muted'}`}>{summary}</button>
                  </li>
                );
              })}
            </ul>
            <div className="hidden min-w-0 rounded-xl border border-border lg:block">
              {showDetails && selected
                ? <ApplicantDetail key={selected.id} applicationId={selected.id} onChanged={() => setRefresh((value) => value + 1)} />
                : <p className="p-8 text-sm text-ink-soft">เลือกผู้สมัครเพื่อดูโปรไฟล์และพิจารณาใบสมัคร</p>}
            </div>
          </div>
        )}
        {result && result.meta.total > PAGE_SIZE && (
          <nav aria-label="เลือกหน้า" className="mt-8 flex items-center justify-center gap-4 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, true)}
              className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
            <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) }, true)}
              className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
          </nav>
        )}
      </section>
    </main>
  );
}
