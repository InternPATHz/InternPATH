'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { ApplicationStatus, Paginated, StudentApplicationItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ApplicationStatusBadge, formatDate } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';
import { APPLICATION_STATUS } from '@/lib/status-map';

const PAGE_SIZE = 20;

export function ApplicationList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const statusParam = searchParams.get('status') ?? '';
  const status = statusParam in APPLICATION_STATUS ? (statusParam as ApplicationStatus) : undefined;
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const [result, setResult] = useState<Paginated<StudentApplicationItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (status) query.set('status', status);
    request<Paginated<StudentApplicationItem>>(`/me/applications?${query}`).then(
      (data) => { if (!cancelled) setResult(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดใบสมัครไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, status, page]);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) { if (value) next.set(name, value); else next.delete(name); }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold">ใบสมัครของฉัน</h1>
      <p className="mt-2 text-sm text-ink-soft">ติดตามสถานะใบสมัครและตอบรับข้อเสนอจากบริษัท</p>

      <div className="mt-6">
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
        {result && result.data.length > 0 && (
          <ul className="space-y-3">
            {result.data.map((application) => (
              <li key={application.id} className="rounded-xl border border-border bg-surface p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <h2 className="text-lg font-semibold">{application.job_title}</h2>
                    <p className="text-sm text-ink-soft">{application.company_name}</p>
                  </div>
                  <ApplicationStatusBadge status={application.status} />
                </div>
                <p className="mt-3 text-xs text-ink-soft">
                  สมัครเมื่อ {formatDate(application.created_at)} · อัปเดตล่าสุด {formatDate(application.status_changed_at)}
                  {application.frozen && ' · ประกาศถูกระงับชั่วคราว'}
                </p>
                <Link href={`/student/applications/item?id=${application.id}`} className="mt-3 inline-block text-sm font-semibold text-primary hover:underline">
                  ดูรายละเอียด
                </Link>
              </li>
            ))}
          </ul>
        )}
        {result && result.meta.total > PAGE_SIZE && (
          <nav aria-label="เลือกหน้า" className="mt-8 flex items-center justify-center gap-4 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, true)}
              className="rounded-lg border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
            <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) }, true)}
              className="rounded-lg border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
          </nav>
        )}
      </section>
    </main>
  );
}
