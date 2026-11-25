'use client';

import { Fragment, useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AuditLogEntry, Paginated } from '@internpath/contracts';
import { AdminPicker } from '@/components/admin/identity/admin-picker';
import { useAuth } from '@/auth/session';
import { endOfDay, startOfDay } from '@/components/admin/audit/audit-meta';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { Badge, formatDateTime } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 20;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** `AUDIT_ACTIONS` / `AuditTargetType` ของ Lifecycle (`apps/lifecycle/src/common/audit/admin-audit.ts`) — ค่าที่ไม่รู้จักแสดงรหัสเดิม */
const ACTION_LABEL: Record<string, string> = {
  APPLICATION_CONFIRM_NO_EVALUATION: 'ยืนยันบริษัทไม่ประเมินผล',
  APPLICATION_TERMINATE: 'ยุติการฝึกงาน',
  REAPPLY_UNLOCK: 'ปลดล็อกการสมัครซ้ำ',
  CERTIFICATE_REVOKE: 'เพิกถอนใบรับรอง',
};
const TARGET_LABEL: Record<string, string> = {
  APPLICATION: 'ใบสมัคร',
  CERTIFICATE: 'ใบรับรอง',
  STUDENT: 'นักศึกษา',
};
const actionLabel = (code: string) => ACTION_LABEL[code] ?? code;
const targetLabel = (code: string) => TARGET_LABEL[code] ?? code;

type Filters = { action: string; target_type: string; target_id: string; actor: string; from: string; to: string; page: number };
const TEXT_KEYS = ['action', 'target_type', 'target_id', 'actor', 'from', 'to'] as const;

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page'));
  const date = (key: string) => { const value = params.get(key) ?? ''; return DATE.test(value) ? value : ''; };
  return {
    action: params.get('action') ?? '', target_type: params.get('target_type') ?? '',
    target_id: params.get('target_id') ?? '', actor: params.get('actor') ?? '',
    from: date('from'), to: date('to'), page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  for (const key of TEXT_KEYS) if (filters[key]) query.set(key, filters[key]);
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

function Json({ title, value }: { title: string; value: unknown }) {
  return (
    <div className="min-w-0 flex-1">
      <p className="text-xs font-medium text-ink-soft">{title}</p>
      <pre className="mt-1 max-h-64 overflow-auto rounded-lg border border-border bg-surface p-3 text-xs">
        {value === null || value === undefined ? '—' : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

/**
 * Audit log ของ Lifecycle (README §5.10, UAT-38) — `GET /admin/lifecycle/audit-logs?actor=&action=&target_type=&target_id=&from=&to=`
 * รูปแบบเดียวกับหน้า Audit log ของ Verification (PM) + ตัวกรอง `target_id` ให้หน้าอื่นลิงก์มาดูประวัติของเป้าหมายเดียวได้
 * (เช่น `?target_id=<application_id>` จากหน้ารายงานปัญหา) • ตัวกรองอยู่ใน URL • append-only แก้/ลบไม่ได้
 */
export function LifecycleAuditLog() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const fieldId = useId();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<AuditLogEntry> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const [targetId, setTargetId] = useState(filters.target_id);
  const [actor, setActor] = useState(filters.actor);
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const [formError, setFormError] = useState('');

  useEffect(() => {
    setTargetId(filters.target_id); setActor(filters.actor); setFrom(filters.from); setTo(filters.to);
  }, [filters.target_id, filters.actor, filters.from, filters.to]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const current = readFilters(new URLSearchParams(queryString));
    const apiQuery = new URLSearchParams();
    if (current.action) apiQuery.set('action', current.action);
    if (current.target_type) apiQuery.set('target_type', current.target_type);
    if (current.target_id) apiQuery.set('target_id', current.target_id);
    if (UUID.test(current.actor)) apiQuery.set('actor', current.actor);
    if (current.from) apiQuery.set('from', startOfDay(current.from));
    if (current.to) apiQuery.set('to', endOfDay(current.to));
    apiQuery.set('page', String(current.page));
    apiQuery.set('page_size', String(PAGE_SIZE));
    request<Paginated<AuditLogEntry>>(`/admin/lifecycle/audit-logs?${apiQuery.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(cause instanceof ApiError ? cause.message : 'โหลด Audit log ไม่สำเร็จ'); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queryString, request]);

  const update = useCallback((patch: Partial<Filters>) => {
    const query = toQuery({ ...filters, page: 1, ...patch });
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, router]);

  function submitText(event: FormEvent) {
    event.preventDefault();
    const trimmedActor = actor.trim();
    const trimmedTarget = targetId.trim();
    if (trimmedActor && !UUID.test(trimmedActor)) { setFormError('รหัสผู้ดูแล (actor) ต้องเป็น UUID'); return; }
    if (trimmedTarget.length > 100) { setFormError('รหัสเป้าหมายต้องไม่เกิน 100 ตัวอักษร'); return; }
    if (from && to && from > to) { setFormError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setFormError('');
    update({ actor: trimmedActor, target_id: trimmedTarget, from, to });
  }

  function clearAll() {
    setTargetId(''); setActor(''); setFrom(''); setTo(''); setFormError('');
    router.replace(pathname);
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = TEXT_KEYS.some((key) => Boolean(filters[key]));
  const inputClass = 'w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary';

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">บันทึกการดำเนินการ · การฝึกงาน</h1>
        <p className="mt-1 text-sm text-ink-soft">
          บันทึกการกระทำของ Admin กับใบสมัคร ใบรับรอง และสิทธิ์สมัครซ้ำ เรียงใหม่ไปเก่า ลบหรือแก้ไม่ได้ (Audit log ของ Verification และ Identity แยกอยู่ที่หน้าของ Service นั้น)
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="การกระทำ" value={filters.action} onChange={(action) => update({ action })}
          options={[['', 'ทั้งหมด'], ...Object.entries(ACTION_LABEL).map(([code, label]): [string, string] => [code, label])]} />
        <FilterSelect label="เป้าหมาย" value={filters.target_type} onChange={(target_type) => update({ target_type })}
          options={[['', 'ทั้งหมด'], ...Object.entries(TARGET_LABEL).map(([code, label]): [string, string] => [code, label])]} />
        <form onSubmit={submitText} noValidate className="flex flex-wrap items-end gap-3">
          <div className="w-72 text-sm">
            <label htmlFor={`${fieldId}-target`} className="mb-1 block text-xs font-medium text-ink-soft">รหัสเป้าหมาย</label>
            <input id={`${fieldId}-target`} value={targetId} onChange={(event) => setTargetId(event.target.value)} spellCheck={false} maxLength={100}
              className={`${inputClass} font-mono text-xs`} />
          </div>
          <AdminPicker value={actor} onChange={setActor} />
          <div className="text-sm">
            <label htmlFor={`${fieldId}-from`} className="mb-1 block text-xs font-medium text-ink-soft">ตั้งแต่วันที่</label>
            <input id={`${fieldId}-from`} type="date" value={from} onChange={(event) => setFrom(event.target.value)} className={inputClass} />
          </div>
          <div className="text-sm">
            <label htmlFor={`${fieldId}-to`} className="mb-1 block text-xs font-medium text-ink-soft">ถึงวันที่</label>
            <input id={`${fieldId}-to`} type="date" value={to} onChange={(event) => setTo(event.target.value)} className={inputClass} />
          </div>
          <button type="submit" className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover">กรอง</button>
          {hasFilter && (
            <button type="button" onClick={clearAll} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-muted">ล้างตัวกรอง</button>
          )}
        </form>
      </div>
      {formError && <Notice tone="error">{formError}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      {/* `relative` ให้ `sr-only` (absolute) ในหัวตารางอยู่ในกล่องเลื่อน — ไม่งั้นหน้าทั้งหน้ากว้างเกินจอมือถือ */}
      <div className="relative overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">เวลา</th>
              <th scope="col" className="px-4 py-3 font-medium">การกระทำ</th>
              <th scope="col" className="px-4 py-3 font-medium">เป้าหมาย</th>
              <th scope="col" className="px-4 py-3 font-medium">ผู้ดูแล</th>
              <th scope="col" className="px-4 py-3 font-medium">เหตุผล</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">รายละเอียด</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-soft">ไม่มีบันทึกตามตัวกรองนี้</td></tr>
            )}
            {result?.data.map((entry) => (
              <Fragment key={entry.id}>
                <tr className="border-t border-border align-top">
                  <td className="whitespace-nowrap px-4 py-3">{formatDateTime(entry.occurred_at)}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{actionLabel(entry.action)}</p>
                    <p className="font-mono text-xs text-ink-soft">{entry.action}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="bg-surface-muted text-ink-soft">{targetLabel(entry.target_type)}</Badge>
                    <p className="mt-1 break-all font-mono text-xs text-ink-soft">{entry.target_id}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs" title={entry.admin_id}>{entry.admin_id.slice(0, 8)}…</td>
                  <td className="max-w-xs whitespace-pre-wrap break-words px-4 py-3">{entry.reason ?? <span className="text-ink-soft">—</span>}</td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" aria-expanded={openId === entry.id} onClick={() => setOpenId(openId === entry.id ? null : entry.id)}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">
                      {openId === entry.id ? 'ซ่อน' : 'ดูก่อน/หลัง'}
                    </button>
                  </td>
                </tr>
                {openId === entry.id && (
                  <tr className="bg-surface-muted">
                    <td colSpan={6} className="px-4 py-4">
                      <div className="flex flex-col gap-3 md:flex-row">
                        <Json title="ก่อน" value={entry.before} />
                        <Json title="หลัง" value={entry.after} />
                      </div>
                      <dl className="mt-3 grid gap-x-6 gap-y-1 text-xs text-ink-soft sm:grid-cols-2">
                        <div><dt className="inline">ผู้ดูแล: </dt><dd className="inline break-all font-mono">{entry.admin_id}</dd></div>
                        <div><dt className="inline">Correlation ID: </dt><dd className="inline break-all font-mono">{entry.correlation_id}</dd></div>
                      </dl>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {result && total > 0 && (
        <div className="flex items-center justify-between text-sm text-ink-soft">
          <span>ทั้งหมด {total} รายการ · หน้า {filters.page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button>
            <button type="button" disabled={filters.page >= lastPage} onClick={() => update({ page: filters.page + 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ถัดไป</button>
          </span>
        </div>
      )}
    </div>
  );
}
