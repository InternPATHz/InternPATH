'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ApplicationStatus, Paginated, StudentApplicationItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ApplicationProgress, ApplicationStatusBadge, formatDate, isClosedApplication } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';
import { allPages } from '@/lib/list';
import { APPLICATION_STATUS } from '@/lib/status-map';

const PAGE_SIZE = 20;

export function ApplicationList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const statusParam = searchParams.get('status') ?? '';
  const status = Object.hasOwn(APPLICATION_STATUS, statusParam) ? (statusParam as ApplicationStatus) : undefined;
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const group = searchParams.get('group') ?? '';
  const [all, setAll] = useState<StudentApplicationItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setAll(null);
    setError(null);
    allPages<StudentApplicationItem>((n) => {
      const query = new URLSearchParams({ page: String(n), page_size: '100' });
      if (status) query.set('status', status);
      return request<Paginated<StudentApplicationItem>>(`/me/applications?${query}`);
    }).then(
      (data) => { if (!cancelled) setAll(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดใบสมัครไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, status]);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) { if (value) next.set(name, value); else next.delete(name); }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const matched = all?.filter((app) => group === 'closed' ? isClosedApplication(app.status) : group === 'active' ? !isClosedApplication(app.status) : true);
  const rank = (app: StudentApplicationItem) => app.status === 'HR_ACCEPTED' && !app.frozen ? 0 : isClosedApplication(app.status) ? 2 : 1;
  const result = matched ? { data: matched.sort((a,b) => rank(a) - rank(b)).slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), meta: { total: matched.length } } : null;
  const active = result?.data.filter((app) => !isClosedApplication(app.status)) ?? [];
  const closed = result?.data.filter((app) => isClosedApplication(app.status)) ?? [];
  const waitingForStudent = active.filter((app) => app.status === 'HR_ACCEPTED' && !app.frozen);
  const waitingIds = new Set(waitingForStudent.map((app) => app.id));
  const otherActive = active.filter((app) => !waitingIds.has(app.id));
  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ใบสมัครของฉัน</h1>
      <p className="mt-2 text-sm text-ink-soft">ติดตามสถานะใบสมัครและตอบรับข้อเสนอจากบริษัท</p>

      <div className="mt-6 flex flex-wrap items-end gap-3">
        <div className="flex flex-wrap gap-2" aria-label="กลุ่มใบสมัคร">{[['','ทั้งหมด'],['active','กำลังดำเนินการ'],['closed','จบแล้ว']].map(([value,label]) =>
          <button key={value} aria-pressed={group === value} onClick={() => update({ group: value || undefined, status: undefined })} className="rounded-full border border-border px-4 py-2 text-sm aria-pressed:border-primary aria-pressed:text-primary">{label}</button>)}</div>
        <FilterSelect
          label="สถานะ" value={status ?? ''} onChange={(value) => update({ status: value || undefined })}
          options={[['', 'ทุกสถานะ'], ...Object.entries(APPLICATION_STATUS).map(([value, view]): [string, string] => [value, view.label])]}
        />
      </div>

      <section aria-busy={!result && !error} className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {result && result.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">{status ? 'ไม่มีใบสมัครในสถานะนี้' : 'ยังไม่มีใบสมัคร'}</p>
            <Link href="/jobs" className="mt-2 inline-block text-sm font-medium text-primary hover:underline">ไปค้นหางาน</Link>
          </div>
        )}
        {[
          { heading: 'ถึงตาคุณ', items: waitingForStudent, highlighted: true, compact: false },
          { heading: 'กำลังดำเนินการ', items: otherActive, highlighted: false, compact: false },
          { heading: 'จบแล้ว', items: closed, highlighted: false, compact: true },
        ].map(({ heading, items, highlighted, compact }) => items.length > 0 && (
          <section key={heading} className="mb-6">
            <h2 className="mb-3 text-lg font-semibold">{heading}</h2>
            <ul className="space-y-3">
              {items.map((app) => (
                <li key={app.id} className={`rounded-xl border border-border bg-surface ${compact ? 'p-4' : 'p-5'}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 [overflow-wrap:anywhere]">
                      <h3 className="font-semibold">{app.job_title}</h3>
                      <p className="text-sm text-ink-soft">{app.company_name}</p>
                    </div>
                    <ApplicationStatusBadge status={app.status} academicResult={app.academic_result} />
                  </div>
                  {!compact && <div className="mt-4"><ApplicationProgress status={app.status} /></div>}
                  <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs text-ink-soft">
                      {compact ? 'อัปเดตล่าสุด' : 'สมัครเมื่อ'} {formatDate(compact ? app.status_changed_at : app.created_at)}
                      {app.frozen && ' · ประกาศถูกระงับชั่วคราว'}
                    </p>
                    <Link href={`/student/applications/item?${new URLSearchParams({ ...Object.fromEntries(searchParams), id: app.id })}`}
                      className={`text-sm font-semibold ${highlighted ? 'rounded-full bg-primary px-4 py-2 text-white hover:bg-primary-hover' : 'text-primary hover:underline'}`}>
                      {highlighted ? 'ดูข้อเสนอ' : 'ดูรายละเอียด ›'}
                    </Link>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ))}
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
