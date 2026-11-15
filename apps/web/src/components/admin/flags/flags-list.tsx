'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { CompanyFlagItem, Paginated, SetCompanyFlagRequest, SetCompanyFlagResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { Badge, formatDateTime } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 20;
const REASON_MAX = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Filters = { active: string; q: string; page: number };

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page'));
  const active = params.get('active');
  return {
    active: active === 'true' || active === 'false' ? active : '',
    q: params.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.active) query.set('active', filters.active);
  if (filters.q.trim()) query.set('q', filters.q.trim());
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

function failure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 404) return 'ไม่พบบริษัทนี้ในระบบตรวจสอบ (ยังไม่เคยมีข้อมูลบริษัทจาก Identity) จึงตั้งธงไม่ได้';
    return cause.message;
  }
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

const SOURCE_LABEL = { SYSTEM: 'ระบบอัตโนมัติ', ADMIN: 'ผู้ดูแล' } as const;

export function FlagsList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<CompanyFlagItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState(filters.q);

  const [openId, setOpenId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');

  const [newCompanyId, setNewCompanyId] = useState('');
  const [newReason, setNewReason] = useState('');
  const [newError, setNewError] = useState('');

  useEffect(() => { setSearch(filters.q); }, [filters.q]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const apiQuery = new URLSearchParams(queryString);
    apiQuery.set('page_size', String(PAGE_SIZE));
    request<Paginated<CompanyFlagItem>>(`/admin/flags/companies?${apiQuery.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(failure(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queryString, reloadKey, request]);

  const update = useCallback((patch: Partial<Filters>) => {
    const query = toQuery({ ...filters, page: 1, ...patch });
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, router]);

  async function setFlag(companyId: string, active: boolean, text: string): Promise<void> {
    const body: SetCompanyFlagRequest = { active, reason: text.trim() };
    try {
      const response = await request<SetCompanyFlagResponse>(`/admin/flags/companies/${encodeURIComponent(companyId)}/under-review`, { method: 'PUT', body });
      setNotice(response.changed ? (active ? 'ตั้งธง UNDER_REVIEW แล้ว' : 'เคลียร์ธง UNDER_REVIEW แล้ว') : 'บริษัทนี้อยู่ในสถานะนี้อยู่แล้ว ไม่มีการเปลี่ยนแปลง');
      setReloadKey((key) => key + 1);
    } catch (cause) {
      throw new Error(failure(cause));
    }
  }

  async function submitRow(event: FormEvent, item: CompanyFlagItem) {
    event.preventDefault();
    if (!reason.trim()) { setFormError('กรุณากรอกเหตุผล'); return; }
    if (reason.trim().length > REASON_MAX) { setFormError(`เหตุผลต้องไม่เกิน ${REASON_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setFormError('');
    setNotice('');
    try {
      await setFlag(item.company_id, !item.active, reason);
      setOpenId(null);
      setReason('');
    } catch (cause) { setFormError(cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  async function submitNew(event: FormEvent) {
    event.preventDefault();
    const id = newCompanyId.trim();
    if (!UUID.test(id)) { setNewError('รหัสบริษัทต้องเป็น UUID'); return; }
    if (!newReason.trim()) { setNewError('กรุณากรอกเหตุผล'); return; }
    if (newReason.trim().length > REASON_MAX) { setNewError(`เหตุผลต้องไม่เกิน ${REASON_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setNewError('');
    setNotice('');
    try {
      await setFlag(id, true, newReason);
      setNewCompanyId('');
      setNewReason('');
    } catch (cause) { setNewError(cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="text-2xl font-bold">ธงบริษัท (UNDER_REVIEW)</h1>
      <p className="mt-1 text-sm text-ink-soft">
        บริษัทที่ติดธงจะมีประกาศใหม่เข้าคิวตรวจโดยอัตโนมัติ ธงตั้งจากระบบ (ประกาศถูกระงับตามเกณฑ์) หรือตั้งด้วยมือที่นี่ ต้องระบุเหตุผลทั้งตอนตั้งและตอนเคลียร์
      </p>

      <form onSubmit={(event) => void submitNew(event)} className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">ตั้งธงให้บริษัท</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[16rem] flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">รหัสบริษัท (UUID)</span>
            <input value={newCompanyId} onChange={(event) => setNewCompanyId(event.target.value)} spellCheck={false}
              className="w-full rounded-lg border border-border px-3 py-2 font-mono text-xs outline-none focus:border-primary" />
          </label>
          <label className="min-w-[16rem] flex-[2] text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">เหตุผล</span>
            <input value={newReason} onChange={(event) => setNewReason(event.target.value)} maxLength={REASON_MAX}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <button type="submit" disabled={busy} className="rounded-lg bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">ตั้งธง</button>
        </div>
        {newError && <div className="mt-3"><Notice tone="error">{newError}</Notice></div>}
      </form>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="สถานะธง" value={filters.active} onChange={(active) => update({ active })}
          options={[['', 'ทั้งหมด'], ['true', 'ติดธงอยู่'], ['false', 'เคลียร์แล้ว']]} />
        <form onSubmit={(event) => { event.preventDefault(); update({ q: search }); }} className="flex items-end gap-2" role="search">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">ค้นชื่อบริษัท</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-muted">ค้นหา</button>
        </form>
      </div>

      {notice && <div className="mt-4"><Notice tone="success">{notice}</Notice></div>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[820px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">บริษัท</th>
              <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
              <th scope="col" className="px-4 py-3 font-medium">เหตุผลที่ตั้งธง</th>
              <th scope="col" className="px-4 py-3 font-medium">ตั้ง / เคลียร์</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">การดำเนินการ</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">ไม่มีบริษัทตามตัวกรองนี้</td></tr>
            )}
            {result?.data.map((item) => (
              <Fragment key={item.company_id}>
                <tr className="border-t border-border align-top">
                  <td className="px-4 py-3">
                    <p className="font-medium">{item.company_name ?? 'ไม่ทราบชื่อ'}</p>
                    <p className="font-mono text-xs text-ink-soft">{item.company_id}</p>
                  </td>
                  <td className="px-4 py-3">
                    <Badge className={item.active ? 'bg-danger-soft text-danger-text' : 'bg-surface-muted text-ink-soft'}>{item.active ? 'ติดธงอยู่' : 'เคลียร์แล้ว'}</Badge>
                    {item.set_by && <p className="mt-1 text-xs text-ink-soft">โดย{SOURCE_LABEL[item.set_by]}</p>}
                    {item.trigger_count !== null && <p className="text-xs text-ink-soft">ประกาศถูกระงับ {item.trigger_count} ครั้ง</p>}
                  </td>
                  <td className="max-w-xs px-4 py-3 whitespace-pre-wrap break-words">{item.set_reason ?? <span className="text-ink-soft">—</span>}</td>
                  <td className="px-4 py-3 text-xs text-ink-soft whitespace-nowrap">
                    <p>ตั้ง: {formatDateTime(item.set_at)}</p>
                    <p>เคลียร์: {formatDateTime(item.cleared_at)}</p>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <button type="button" onClick={() => { setOpenId(openId === item.company_id ? null : item.company_id); setReason(''); setFormError(''); }}
                      className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">
                      {item.active ? 'เคลียร์ธง' : 'ตั้งธงอีกครั้ง'}
                    </button>
                  </td>
                </tr>
                {openId === item.company_id && (
                  <tr className="bg-surface-muted">
                    <td colSpan={5} className="px-4 py-4">
                      <form onSubmit={(event) => void submitRow(event, item)} className="max-w-xl">
                        <label className="block text-sm">
                          <span className="font-medium">เหตุผลที่{item.active ? 'เคลียร์ธง' : 'ตั้งธง'} (จำเป็น)</span>
                          <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={2} maxLength={REASON_MAX}
                            className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary" />
                        </label>
                        {formError && <div className="mt-2"><Notice tone="error">{formError}</Notice></div>}
                        <div className="mt-3 flex gap-2">
                          <button type="submit" disabled={busy} className={`rounded-lg px-4 py-2 text-sm font-semibold text-white disabled:opacity-50 ${item.active ? 'bg-primary hover:bg-primary-hover' : 'bg-danger hover:opacity-90'}`}>
                            ยืนยัน{item.active ? 'เคลียร์ธง' : 'ตั้งธง'}
                          </button>
                          <button type="button" onClick={() => setOpenId(null)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface">ยกเลิก</button>
                        </div>
                      </form>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>

      {result && total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
          <span>ทั้งหมด {total} บริษัท · หน้า {filters.page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button>
            <button type="button" disabled={filters.page >= lastPage} onClick={() => update({ page: filters.page + 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ถัดไป</button>
          </span>
        </div>
      )}
    </div>
  );
}
