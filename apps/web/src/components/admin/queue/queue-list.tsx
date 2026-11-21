'use client';

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { Paginated, QueueItemStatus, QueueItemSummary, QueueItemType } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';
import { ItemBadges, STATUS_LABEL, TYPE_LABEL, formatDateTime } from './queue-ui';

const PAGE_SIZE = 20;

/** ตัวกรองเก็บใน URL เพื่อแชร์ลิงก์/รีเฟรชแล้วคงค่าเดิม; `status` ไม่ระบุ = เฉพาะที่ยังไม่ปิด (ตรงกับ API) */
type Filters = { type: string; status: string; overdue: string; page: number };

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page'));
  return {
    type: params.get('type') ?? '',
    status: params.get('status') ?? '', overdue: params.get('overdue') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  for (const key of ['type', 'status', 'overdue'] as const) if (filters[key]) query.set(key, filters[key]);
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

export function QueueList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<QueueItemSummary> | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const apiQuery = new URLSearchParams(queryString);
    apiQuery.set('page_size', String(PAGE_SIZE));
    request<Paginated<QueueItemSummary>>(`/admin/queue?${apiQuery.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => {
        if (!active) return;
        setResult(null);
        setError(cause instanceof ApiError ? cause.message : 'โหลดคิวไม่สำเร็จ');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queryString, request]);

  const update = useCallback((patch: Partial<Filters>) => {
    const next = { ...filters, page: 1, ...patch };
    const query = toQuery(next);
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, router]);

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="text-2xl font-semibold">คิวตรวจ</h1>
      <p className="mt-1 text-sm text-ink-soft">ประกาศของบริษัทที่ติดธงรอตรวจ รายงานประกาศ รายงานรีวิว และธงบริษัท เรียงตามกำหนดเวลา</p>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="ประเภท" value={filters.type} onChange={(type) => update({ type })}
          options={[['', 'ทั้งหมด'], ...(Object.keys(TYPE_LABEL) as QueueItemType[]).map((key): [string, string] => [key, TYPE_LABEL[key]])]} />
        <FilterSelect label="สถานะ" value={filters.status} onChange={(status) => update({ status })}
          options={[['', 'ที่ยังไม่ปิด'], ...(Object.keys(STATUS_LABEL) as QueueItemStatus[]).map((key): [string, string] => [key, STATUS_LABEL[key]])]} />
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={filters.overdue === 'true'} onChange={(event) => update({ overdue: event.target.checked ? 'true' : '' })}
            className="accent-primary" />
          เฉพาะเกินกำหนด
        </label>
      </div>

      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[720px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">รายการ</th>
              <th scope="col" className="px-4 py-3 font-medium">บริษัท</th>
              <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
              <th scope="col" className="px-4 py-3 font-medium">ครบกำหนด</th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && (
              <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-soft">ไม่มีรายการตามตัวกรองนี้</td></tr>
            )}
            {result?.data.map((item) => (
              <tr key={item.id} className="border-t border-border hover:bg-surface-muted">
                <td className="px-4 py-3">
                  <Link href={`/admin/queue/item?id=${item.id}`} className="font-semibold text-primary hover:underline">{TYPE_LABEL[item.type]}</Link>
                  <div className="mt-1"><ItemBadges item={item} /></div>
                </td>
                <td className="px-4 py-3">{item.company_name ?? <span className="text-ink-soft">—</span>}</td>
                <td className="px-4 py-3">{STATUS_LABEL[item.status]}</td>
                <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(item.due_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {result && total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
          <span>ทั้งหมด {total} รายการ · หน้า {filters.page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button>
            <button type="button" disabled={filters.page >= lastPage} onClick={() => update({ page: filters.page + 1 })}
              className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ถัดไป</button>
          </span>
        </div>
      )}
    </div>
  );
}
