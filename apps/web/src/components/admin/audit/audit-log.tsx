'use client';

import Link from 'next/link';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { AdminUserListItem, AuditLogEntry, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { Badge, formatDateTime } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';
import { ACTION_LABEL, TARGET_LABEL, actionLabel, endOfDay, startOfDay, targetLabel } from './audit-meta';

const PAGE_SIZE = 20;
const dateKey = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', dateStyle: 'short' });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

type Filters = { action: string; target_type: string; actor: string; from: string; to: string; page: number };
type AuditAdmin = Pick<AdminUserListItem, 'full_name' | 'email'>;

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page'));
  const date = (key: string) => { const value = params.get(key) ?? ''; return DATE.test(value) ? value : ''; };
  return {
    action: params.get('action') ?? '', target_type: params.get('target_type') ?? '', actor: params.get('actor') ?? '',
    from: date('from'), to: date('to'), page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  for (const key of ['action', 'target_type', 'actor', 'from', 'to'] as const) if (filters[key]) query.set(key, filters[key]);
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

function asFields(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  return { 'ค่า': value };
}

function stableJson(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item;
    return Object.fromEntries(Object.entries(item).sort(([first], [second]) => first.localeCompare(second)));
  });
}

function AuditChanges({ before, after }: { before: unknown; after: unknown }) {
  const fields = [asFields(before), asFields(after)];
  const keys = [...new Set(fields.flatMap((side) => Object.keys(side)))];
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {fields.map((side, index) => (
        <div key={index} className="min-w-0 rounded-lg border border-border bg-surface p-3">
          <h3 className="text-sm font-semibold">{index === 0 ? 'ก่อน' : 'หลัง'}</h3>
          {keys.length === 0 ? <p className="mt-2 text-xs text-ink-soft">—</p> : <dl className="mt-2 space-y-1 text-xs">
            {keys.map((key) => {
              const changed = stableJson(fields[0][key]) !== stableJson(fields[1][key]);
              return (
                <div key={key} className={`rounded px-2 py-1 ${changed ? index === 0 ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text' : ''}`}>
                  <dt className="break-all font-semibold">{key}{changed && <span className="sr-only"> มีการเปลี่ยนแปลง</span>}</dt>
                  <dd className="whitespace-pre-wrap break-all font-mono">{Object.hasOwn(side, key) ? JSON.stringify(side[key], null, 2) : '—'}</dd>
                </div>
              );
            })}
          </dl>}
        </div>
      ))}
    </div>
  );
}

export function AuditLog() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<AuditLogEntry> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [openId, setOpenId] = useState<string | null>(null);

  const [actor, setActor] = useState(filters.actor);
  const [from, setFrom] = useState(filters.from);
  const [to, setTo] = useState(filters.to);
  const [admins, setAdmins] = useState(() => new Map<string, AuditAdmin>());
  const [desktopFilter, setDesktopFilter] = useState(false);
  const [adminsFailed, setAdminsFailed] = useState(false);
  const [adminRetry, setAdminRetry] = useState(0);
  const [formError, setFormError] = useState('');

  const adminFilter = useMemo(() => {
    const nameCounts = new Map<string, number>();
    if (desktopFilter) {
      for (const { full_name } of admins.values()) {
        nameCounts.set(full_name, (nameCounts.get(full_name) ?? 0) + 1);
      }
    }
    const options: Array<[string, string]> = [['', 'ผู้ดูแลทั้งหมด']];
    for (const [id, { full_name, email }] of admins) {
      const label = (nameCounts.get(full_name) ?? 0) > 1 ? `${full_name} (${email})` : full_name;
      options.push([id, label]);
    }
    return { options, hasDuplicateNames: desktopFilter && nameCounts.size < admins.size };
  }, [admins, desktopFilter]);

  useEffect(() => { setActor(filters.actor); setFrom(filters.from); setTo(filters.to); }, [filters.actor, filters.from, filters.to]);

  useEffect(() => {
    const desktop = window.matchMedia('(min-width: 1024px)');
    const getPage = (page: number) => request<Paginated<AdminUserListItem>>(
      `/admin/users?role=PLATFORM_ADMIN&page_size=100&page=${page}`,
    );
    const firstPage = getPage(1);
    let revision = 0;

    async function loadAdmins() {
      const current = ++revision;
      const byId = new Map<string, AuditAdmin>();
      setDesktopFilter(desktop.matches);
      setAdminsFailed(false);
      try {
        let result = await firstPage;
        for (let page = 1; current === revision; page++) {
          for (const { id, full_name, email } of result.data) byId.set(id, { full_name, email });
          setAdmins(new Map(byId));
          if (!desktop.matches || !result.data.length || page * result.meta.page_size >= result.meta.total) break;
          result = await getPage(page + 1);
        }
      } catch {
        if (current === revision && desktop.matches) setAdminsFailed(true);
      }
    }

    void loadAdmins();
    desktop.addEventListener('change', loadAdmins);
    return () => {
      revision++;
      desktop.removeEventListener('change', loadAdmins);
    };
  }, [request, adminRetry]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const current = readFilters(new URLSearchParams(queryString));
    const apiQuery = new URLSearchParams();
    if (current.action) apiQuery.set('action', current.action);
    if (current.target_type) apiQuery.set('target_type', current.target_type);
    if (UUID.test(current.actor)) apiQuery.set('actor', current.actor);
    if (current.from) apiQuery.set('from', startOfDay(current.from));
    if (current.to) apiQuery.set('to', endOfDay(current.to));
    apiQuery.set('page', String(current.page));
    apiQuery.set('page_size', String(PAGE_SIZE));
    request<Paginated<AuditLogEntry>>(`/admin/audit?${apiQuery.toString()}`)
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
    const trimmed = actor.trim();
    if (trimmed && !UUID.test(trimmed)) { setFormError('รหัสผู้ดูแล (actor) ต้องเป็น UUID'); return; }
    if (from && to && from > to) { setFormError('วันที่เริ่มต้นต้องไม่เกินวันที่สิ้นสุด'); return; }
    setFormError('');
    update({ actor: trimmed, from, to });
  }

  function setQuickRange(days: number) {
    const now = Date.now();
    setFormError('');
    update({ from: dateKey.format(now - (days - 1) * 86_400_000), to: dateKey.format(now) });
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const hasFilter = Boolean(filters.action || filters.target_type || filters.actor || filters.from || filters.to);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">บันทึกการดำเนินการ · คิวตรวจและธงบริษัท</h1>
        <p className="mt-1 text-sm text-ink-soft">
          บันทึกการกระทำของ Admin ในส่วนตรวจสอบและความไว้วางใจ เรียงใหม่ไปเก่า ลบหรือแก้ไม่ได้ · ดู{' '}
          <Link href="/admin/identity-audit" className="text-primary hover:underline">Audit log ของ Identity</Link> และ{' '}
          <Link href="/admin/lifecycle-audit" className="text-primary hover:underline">Audit log ของ Lifecycle</Link>
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="การกระทำ" value={filters.action} onChange={(action) => update({ action })}
          options={[['', 'ทั้งหมด'], ...Object.entries(ACTION_LABEL).map(([code, label]): [string, string] => [code, label])]} />
        <FilterSelect label="เป้าหมาย" value={filters.target_type} onChange={(target_type) => update({ target_type })}
          options={[['', 'ทั้งหมด'], ...Object.entries(TARGET_LABEL).map(([code, label]): [string, string] => [code, label])]} />
        <form onSubmit={submitText} className="flex min-w-0 max-w-full flex-wrap items-end gap-3">
          <div className={`w-full min-w-0 max-w-72 space-y-2 ${adminFilter.hasDuplicateNames ? 'lg:w-fit lg:max-w-full' : ''}`}>
            {admins.size > 0 && (
              <FilterSelect label="ผู้ดูแล" value={admins.has(actor) ? actor : ''} onChange={setActor} options={adminFilter.options} />
            )}
            {adminsFailed && (
              <p role="status" className="hidden text-xs text-ink-soft lg:block">
                โหลดรายชื่อผู้ดูแลไม่ครบ{' '}
                <button type="button" className="font-medium text-primary hover:underline" onClick={() => setAdminRetry((value) => value + 1)}>ลองอีกครั้ง</button>
              </p>
            )}
            <details open={actor && !admins.has(actor) ? true : undefined} className="text-sm">
              <summary className="cursor-pointer text-primary">ใช้รหัสผู้ดูแล (UUID)</summary>
              <input aria-label="ผู้ดูแล (UUID)" value={actor} onChange={(event) => setActor(event.target.value)} spellCheck={false}
                className="mt-2 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs outline-none focus:border-primary" />
            </details>
          </div>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">ตั้งแต่วันที่</span>
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">ถึงวันที่</span>
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <div className="flex gap-2">
            {[7, 30].map((days) => (
              <button key={days} type="button" onClick={() => setQuickRange(days)}
                className="rounded-full border border-border px-3 py-2 text-sm hover:bg-surface-muted">{days} วัน</button>
            ))}
          </div>
          <button type="submit" className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover">กรอง</button>
          {hasFilter && (
            <button type="button" onClick={() => { setActor(''); setFrom(''); setTo(''); setFormError(''); router.replace(pathname); }}
              className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface-muted">ล้างตัวกรอง</button>
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
                  <td className="px-4 py-3 whitespace-nowrap">{formatDateTime(entry.occurred_at)}</td>
                  <td className="px-4 py-3">
                    <p className="font-medium">{actionLabel(entry.action)}</p>
                    <p className="font-mono text-xs text-ink-soft">{entry.action}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className="bg-surface-muted text-ink-soft">{targetLabel(entry.target_type)}</Badge>
                    <p className="mt-1 break-all font-mono text-xs text-ink-soft">{entry.target_id}</p>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs lg:[overflow-wrap:anywhere]" title={entry.admin_id}>{admins.get(entry.admin_id)?.full_name ?? `${entry.admin_id.slice(0, 8)}…`}</td>
                  <td className="max-w-xs px-4 py-3 whitespace-pre-wrap break-words">{entry.reason ?? <span className="text-ink-soft">—</span>}</td>
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
                      <AuditChanges before={entry.before} after={entry.after} />
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
