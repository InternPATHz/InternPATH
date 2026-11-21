'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ApplicationStatus, HrApplicationItem, Paginated } from '@internpath/contracts';
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
  const statusParam = searchParams.get('status') ?? '';
  const status = statusParam in APPLICATION_STATUS ? (statusParam as ApplicationStatus) : undefined;
  const jobParam = searchParams.get('job_id') ?? '';
  const jobId = UUID.test(jobParam) ? jobParam : undefined;
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const [result, setResult] = useState<Paginated<HrApplicationItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (status) query.set('status', status);
    if (jobId) query.set('job_id', jobId);
    request<Paginated<HrApplicationItem>>(`/hr/applications?${query}`).then(
      (data) => { if (!cancelled) setResult(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดรายการผู้สมัครไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, status, jobId, page]);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) { if (value) next.set(name, value); else next.delete(name); }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
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
        {jobId && (
          <p className="pb-2 text-sm">
            เฉพาะประกาศเดียว <button type="button" onClick={() => update({ job_id: undefined })} className="font-medium text-primary hover:underline">ดูทุกประกาศ</button>
          </p>
        )}
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
          <ul className="space-y-3">
            {result.data.map((application) => (
              <li key={application.id} className="rounded-xl border border-border bg-surface p-5">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{application.job_title}</h2>
                    <p className="text-sm text-ink-soft">ผู้สมัคร #{application.student_user_id.slice(0, 8)}{application.major_mismatch && ' · สาขาไม่ตรงกับประกาศ'}</p>
                  </div>
                  <ApplicationStatusBadge status={application.status} />
                </div>
                <p className="mt-3 text-xs text-ink-soft">
                  สมัครเมื่อ {formatDate(application.created_at)} · อัปเดตล่าสุด {formatDate(application.status_changed_at)}
                  {application.frozen && ' · ประกาศถูกระงับชั่วคราว'}
                </p>
                <Link href={`/hr/applicants/item?id=${application.id}`} className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">
                  ดูรายละเอียดและดำเนินการ
                </Link>
              </li>
            ))}
          </ul>
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
