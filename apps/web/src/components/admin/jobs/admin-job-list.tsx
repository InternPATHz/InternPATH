'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { AdminJobItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { CompanyPicker } from '@/components/admin/identity/company-picker';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';
import { CATEGORIES } from '@/lib/categories';
import { JOB_STATUS, statusView } from '@/lib/status-map';

const PAGE_SIZE = 20;
const DATE = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeZone: 'Asia/Bangkok' });
const BUTTON = 'rounded-lg border border-border px-3 py-1.5 disabled:opacity-40';
const INPUT =
  'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary';

const STATUS_LABEL: Record<string, string> = {
  AUTO_REJECTED: 'ไม่ผ่านการตรวจอัตโนมัติ',
  ADMIN_REJECTED: 'Admin ปฏิเสธ',
  REMOVED: 'นำออก',
};
const statusLabel = (status: string) =>
  STATUS_LABEL[status] ?? statusView(JOB_STATUS, status).label;
const statusOptions: Array<[string, string]> = [
  ['', 'ทุกสถานะ'],
  ...Object.keys(JOB_STATUS).map((status): [string, string] => [status, statusLabel(status)]),
];

type Filters = { status: string; company_id: string; q: string };
type Query = Filters & { page: number };
type Response =
  | { query: Query; data: Paginated<AdminJobItem> }
  | { query: Query; error: string; unauthorized: boolean };

const emptyFilters: Filters = { status: '', company_id: '', q: '' };

export function AdminJobList() {
  const { request } = useAuth();
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [query, setQuery] = useState<Query>({ ...emptyFilters, page: 1 });
  const [response, setResponse] = useState<Response | null>(null);

  useEffect(() => {
    let active = true;
    const params = new URLSearchParams({ page: String(query.page), page_size: String(PAGE_SIZE) });
    for (const key of ['status', 'company_id', 'q'] as const) {
      if (query[key]) params.set(key, query[key]);
    }

    void request<Paginated<AdminJobItem>>(`/admin/jobs?${params.toString()}`)
      .then((data) => {
        if (active) setResponse({ query, data });
      })
      .catch((cause: unknown) => {
        if (!active) return;
        const unauthorized =
          cause instanceof ApiError && (cause.status === 401 || cause.status === 403);
        const error = unauthorized
          ? 'ไม่มีสิทธิ์ดูรายการประกาศงาน กรุณาเข้าสู่ระบบด้วยบัญชี Admin'
          : cause instanceof ApiError
            ? cause.message
            : 'โหลดรายการประกาศงานไม่สำเร็จ';
        setResponse({ query, error, unauthorized });
      });
    return () => {
      active = false;
    };
  }, [query, request]);

  const current = response?.query === query ? response : null;
  const result = current && 'data' in current ? current.data : null;
  const lastPage = result ? Math.max(1, Math.ceil(result.meta.total / result.meta.page_size)) : 1;

  return (
    <div>
      <h1 className="text-2xl font-semibold">ประกาศทุกสถานะ</h1>

      <form
        className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4"
        onSubmit={(event) => {
          event.preventDefault();
          setQuery({
            ...filters,
            company_id: filters.company_id.trim(),
            q: filters.q.trim(),
            page: 1,
          });
        }}
      >
        <div className="min-w-48 flex-1">
          <label
            htmlFor="admin-jobs-search"
            className="mb-1 block text-xs font-medium text-ink-soft"
          >
            ชื่อตำแหน่งหรือรายละเอียด
          </label>
          <input
            id="admin-jobs-search"
            type="search"
            value={filters.q}
            maxLength={200}
            onChange={(event) => setFilters({ ...filters, q: event.target.value })}
            className={INPUT}
          />
        </div>
        <FilterSelect
          label="สถานะ"
          value={filters.status}
          options={statusOptions}
          onChange={(status) => setFilters({ ...filters, status })}
        />
        {(filters.q || filters.company_id || filters.status || query.q || query.company_id || query.status) && <button type="button" className="text-sm text-primary" onClick={() => { setFilters(emptyFilters); setQuery({ ...emptyFilters, page: 1 }); }}>ล้างตัวกรอง</button>}
        <CompanyPicker value={filters.company_id} onChange={(company_id) => setFilters({ ...filters, company_id })} />
        <button
          type="submit"
          className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white"
        >
          ค้นหา
        </button>
      </form>

      <div className="mt-4" aria-busy={!current}>
        {!current && (
          <p role="status" className="text-sm text-ink-soft">
            กำลังโหลดประกาศ…
          </p>
        )}
        {current && 'error' in current && (
          <>
            <Notice tone="error">{current.error}</Notice>
            {!current.unauthorized && (
              <button
                type="button"
                className={`mt-3 text-sm ${BUTTON}`}
                onClick={() => setQuery({ ...query })}
              >
                ลองอีกครั้ง
              </button>
            )}
          </>
        )}
        {result && result.data.length === 0 && (
          <p className="text-sm text-ink-soft">ไม่มีประกาศตามตัวกรองนี้</p>
        )}
        {result && result.data.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border bg-surface">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
                <tr>
                  <th scope="col" className="px-4 py-3 font-medium">
                    ประกาศ
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    บริษัท
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    สถานะ
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    วันที่
                  </th>
                  <th scope="col" className="px-4 py-3 font-medium">
                    ข้อมูลสำหรับ Admin
                  </th>
                </tr>
              </thead>
              <tbody>
                {result.data.map((job) => (
                  <JobRow key={job.id} job={job} />
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result && (
          <div className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm text-ink-soft">
            <span>
              ทั้งหมด {result.meta.total} ประกาศ
              {result.meta.total > 0 && ` · หน้า ${result.meta.page} จาก ${lastPage}`}
            </span>
            {result.meta.total > 0 && (
              <div className="flex gap-2">
                <button
                  type="button"
                  className={BUTTON}
                  disabled={query.page <= 1}
                  onClick={() => setQuery({ ...query, page: query.page - 1 })}
                >
                  ก่อนหน้า
                </button>
                <button
                  type="button"
                  className={BUTTON}
                  disabled={query.page >= lastPage}
                  onClick={() => setQuery({ ...query, page: query.page + 1 })}
                >
                  ถัดไป
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function JobRow({ job }: { job: AdminJobItem }) {
  const status = statusView(JOB_STATUS, job.status);
  const category = CATEGORIES.find((item) => item.id === job.category)?.label;
  const hasDetails = job.contact_notes || job.admin_reason || job.suspended_from_status;
  const jobTitle = job.job_title?.trim();
  const visibleJobTitle = jobTitle || 'ยังไม่ระบุชื่อตำแหน่ง';
  const queueJobName = jobTitle || `${visibleJobTitle} รหัส ${job.id}`;

  return (
    <tr className="border-t border-border align-top">
      <td className="px-4 py-3">
        <p className="break-words font-semibold text-ink">{visibleJobTitle}</p>
        {category && <p className="mt-1 text-xs text-ink-soft">{category}</p>}
        <p className="mt-1 break-all text-xs text-ink-soft">{job.id}</p>
      </td>
      <td className="px-4 py-3">
        <p className="break-words">{job.company.name || 'ไม่พบชื่อบริษัท'}</p>
        <p className="mt-1 break-all text-xs text-ink-soft">{job.company.id}</p>
      </td>
      <td className="px-4 py-3">
        <StatusBadge tone={status.tone} icon={status.icon}>
          {statusLabel(job.status)}
        </StatusBadge>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-ink-soft">
        <div>
          สร้าง <time dateTime={job.created_at}>{DATE.format(new Date(job.created_at))}</time>
        </div>
        <div className="mt-1">
          ปิดรับ{' '}
          {job.application_deadline ? (
            <time dateTime={job.application_deadline}>{job.application_deadline}</time>
          ) : (
            '—'
          )}
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="mb-1">
          <Link
            href={`/admin/queue?target_id=${encodeURIComponent(job.id)}`}
            prefetch={false}
            aria-label={`ดูคิวของประกาศนี้ (${queueJobName})`}
            className="font-medium text-primary hover:underline"
          >
            ดูคิวของประกาศนี้
          </Link>
        </div>
        {job.report_queue_item_id && (
          <Link
            href={`/admin/queue/item?id=${encodeURIComponent(job.report_queue_item_id)}`}
            aria-label={`เปิดคิวรายงาน (${queueJobName})`}
            className="font-medium text-primary hover:underline"
          >
            เปิดคิวรายงาน
          </Link>
        )}
        {hasDetails && (
          <details className="mt-1">
            <summary className="cursor-pointer text-sm text-ink-soft">ดูรายละเอียด</summary>
            <dl className="mt-2 max-w-xs space-y-2 whitespace-pre-wrap break-words text-xs">
              {job.contact_notes && (
                <div>
                  <dt className="font-semibold">หมายเหตุการติดต่อ</dt>
                  <dd>{job.contact_notes}</dd>
                </div>
              )}
              {job.admin_reason && (
                <div>
                  <dt className="font-semibold">เหตุผลที่ปฏิเสธ</dt>
                  <dd>{job.admin_reason}</dd>
                </div>
              )}
              {job.suspended_from_status && (
                <div>
                  <dt className="font-semibold">สถานะก่อนระงับ</dt>
                  <dd>{statusLabel(job.suspended_from_status)}</dd>
                </div>
              )}
            </dl>
          </details>
        )}
      </td>
    </tr>
  );
}
