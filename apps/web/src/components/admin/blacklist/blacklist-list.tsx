'use client';

import { Fragment, useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type {
  BlacklistSeverity, BlacklistTermItem, CreateBlacklistTermRequest, Paginated, UpdateBlacklistTermRequest,
} from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { Badge } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';
import { BlacklistTestPanel } from './blacklist-test-panel';

const PAGE_SIZE = 20;
const TERM_MAX = 100;
const CATEGORY_MAX = 50;

type Filters = { severity: string; enabled: string; q: string; page: number };

function readFilters(params: URLSearchParams): Filters {
  const page = Number(params.get('page'));
  const severity = params.get('severity');
  const enabled = params.get('enabled');
  return {
    severity: severity === 'HARD' || severity === 'SOFT' ? severity : '',
    enabled: enabled === 'true' || enabled === 'false' ? enabled : '',
    q: params.get('q') ?? '',
    page: Number.isInteger(page) && page > 0 ? page : 1,
  };
}

function toQuery(filters: Filters): string {
  const query = new URLSearchParams();
  if (filters.severity) query.set('severity', filters.severity);
  if (filters.enabled) query.set('enabled', filters.enabled);
  if (filters.q.trim()) query.set('q', filters.q.trim());
  if (filters.page > 1) query.set('page', String(filters.page));
  return query.toString();
}

function failure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return 'มีคำนี้อยู่ในรายการแล้ว (ไม่สนตัวพิมพ์ใหญ่เล็ก)';
    if (cause.status === 404) return 'ไม่พบคำนี้แล้ว อาจถูกลบไปก่อนหน้า';
    return cause.message;
  }
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

const isWeight = (value: string): boolean => /^\d+$/.test(value.trim());

export function BlacklistList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const filters = readFilters(new URLSearchParams(searchParams.toString()));
  const queryString = toQuery(filters);

  const [result, setResult] = useState<Paginated<BlacklistTermItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [search, setSearch] = useState(filters.q);
  const [busy, setBusy] = useState(false);

  // ฟอร์มเพิ่มคำ
  const [term, setTerm] = useState('');
  const [severity, setSeverity] = useState<BlacklistSeverity>('SOFT');
  const [weight, setWeight] = useState('10');
  const [category, setCategory] = useState('');
  const [addError, setAddError] = useState('');

  // แก้ไขรายแถว / ยืนยันลบ
  const [editId, setEditId] = useState<string | null>(null);
  const [editWeight, setEditWeight] = useState('');
  const [editCategory, setEditCategory] = useState('');
  const [editError, setEditError] = useState('');
  const [deleteId, setDeleteId] = useState<string | null>(null);

  useEffect(() => { setSearch(filters.q); }, [filters.q]);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const apiQuery = new URLSearchParams(queryString);
    apiQuery.set('page_size', String(PAGE_SIZE));
    request<Paginated<BlacklistTermItem>>(`/admin/blacklist?${apiQuery.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(failure(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [queryString, reloadKey, request]);

  const update = useCallback((patch: Partial<Filters>) => {
    const query = toQuery({ ...filters, page: 1, ...patch });
    router.replace(query ? `${pathname}?${query}` : pathname);
  }, [filters, pathname, router]);

  const reload = () => setReloadKey((key) => key + 1);

  async function patch(id: string, body: UpdateBlacklistTermRequest, message: string): Promise<boolean> {
    setBusy(true);
    setNotice('');
    try {
      await request<BlacklistTermItem>(`/admin/blacklist/${encodeURIComponent(id)}`, { method: 'PATCH', body });
      setNotice(message);
      reload();
      return true;
    } catch (cause) {
      setError(failure(cause));
      return false;
    } finally { setBusy(false); }
  }

  async function submitAdd(event: FormEvent) {
    event.preventDefault();
    const trimmed = term.trim();
    if (!trimmed) { setAddError('กรุณากรอกคำ'); return; }
    if (trimmed.length > TERM_MAX) { setAddError(`คำต้องไม่เกิน ${TERM_MAX} ตัวอักษร`); return; }
    if (category.trim().length > CATEGORY_MAX) { setAddError(`หมวดต้องไม่เกิน ${CATEGORY_MAX} ตัวอักษร`); return; }
    if (severity === 'SOFT' && !isWeight(weight)) { setAddError('น้ำหนักของคำแบบ SOFT ต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป'); return; }
    const body: CreateBlacklistTermRequest = {
      term: trimmed, severity,
      ...(severity === 'SOFT' ? { weight: Number(weight) } : {}),
      ...(category.trim() ? { category: category.trim() } : {}),
    };
    setBusy(true);
    setAddError('');
    setNotice('');
    try {
      await request<BlacklistTermItem>('/admin/blacklist', { method: 'POST', body });
      setNotice(`เพิ่มคำ "${trimmed}" แล้ว`);
      setTerm('');
      setCategory('');
      reload();
    } catch (cause) { setAddError(failure(cause)); }
    finally { setBusy(false); }
  }

  async function submitEdit(event: FormEvent, item: BlacklistTermItem) {
    event.preventDefault();
    if (editCategory.trim().length > CATEGORY_MAX) { setEditError(`หมวดต้องไม่เกิน ${CATEGORY_MAX} ตัวอักษร`); return; }
    if (item.severity === 'SOFT' && !isWeight(editWeight)) { setEditError('น้ำหนักต้องเป็นจำนวนเต็มตั้งแต่ 0 ขึ้นไป'); return; }
    const body: UpdateBlacklistTermRequest = {
      ...(item.severity === 'SOFT' ? { weight: Number(editWeight) } : {}),
      ...(editCategory.trim() ? { category: editCategory.trim() } : {}),
    };
    if (Object.keys(body).length === 0) { setEditId(null); return; }
    setEditError('');
    if (await patch(item.id, body, `แก้ไขคำ "${item.term}" แล้ว`)) setEditId(null);
  }

  async function remove(item: BlacklistTermItem) {
    setBusy(true);
    setNotice('');
    try {
      await request<void>(`/admin/blacklist/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      setNotice(`ลบคำ "${item.term}" แล้ว`);
      setDeleteId(null);
      reload();
    } catch (cause) { setError(failure(cause)); setDeleteId(null); }
    finally { setBusy(false); }
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold">Blacklist คำต้องห้าม</h1>
        <p className="mt-1 text-sm text-ink-soft">
          คำแบบ HARD ทำให้ประกาศถูกปฏิเสธอัตโนมัติทันที ส่วนคำแบบ SOFT เพิ่มคะแนนความเสี่ยงตามน้ำหนัก (คำที่อยู่ในประโยคปฏิเสธไม่นับ)
          ทุกการเพิ่ม แก้ไข และลบถูกบันทึกใน Audit log
        </p>
      </div>

      <BlacklistTestPanel />

      <form onSubmit={(event) => void submitAdd(event)} className="rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">เพิ่มคำต้องห้าม</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[12rem] flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">คำ</span>
            <input value={term} onChange={(event) => setTerm(event.target.value)} maxLength={TERM_MAX}
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <FilterSelect label="ระดับ" value={severity} onChange={(value) => setSeverity(value === 'HARD' ? 'HARD' : 'SOFT')}
            options={[['SOFT', 'SOFT (เพิ่มคะแนน)'], ['HARD', 'HARD (ปฏิเสธทันที)']]} />
          {severity === 'SOFT' && (
            <label className="w-28 text-sm">
              <span className="mb-1 block text-xs font-medium text-ink-soft">น้ำหนัก</span>
              <input value={weight} onChange={(event) => setWeight(event.target.value)} inputMode="numeric"
                className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
            </label>
          )}
          <label className="w-40 text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">หมวด (ไม่บังคับ)</span>
            <input value={category} onChange={(event) => setCategory(event.target.value)} maxLength={CATEGORY_MAX} placeholder="GENERAL"
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">เพิ่มคำ</button>
        </div>
        {addError && <div className="mt-3"><Notice tone="error">{addError}</Notice></div>}
      </form>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="ระดับ" value={filters.severity} onChange={(value) => update({ severity: value })}
          options={[['', 'ทั้งหมด'], ['HARD', 'HARD'], ['SOFT', 'SOFT']]} />
        <FilterSelect label="สถานะ" value={filters.enabled} onChange={(value) => update({ enabled: value })}
          options={[['', 'ทั้งหมด'], ['true', 'เปิดใช้งาน'], ['false', 'ปิดอยู่']]} />
        <form onSubmit={(event) => { event.preventDefault(); update({ q: search }); }} className="flex items-end gap-2" role="search">
          <label className="text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">ค้นคำ</span>
            <input value={search} onChange={(event) => setSearch(event.target.value)}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <button type="submit" className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-surface-muted">ค้นหา</button>
        </form>
      </div>

      {notice && <Notice tone="success">{notice}</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <div className="overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[760px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">คำ</th>
              <th scope="col" className="px-4 py-3 font-medium">ระดับ</th>
              <th scope="col" className="px-4 py-3 font-medium">น้ำหนัก</th>
              <th scope="col" className="px-4 py-3 font-medium">หมวด</th>
              <th scope="col" className="px-4 py-3 font-medium">ใช้งาน</th>
              <th scope="col" className="px-4 py-3"><span className="sr-only">การดำเนินการ</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-ink-soft">ไม่มีคำตามตัวกรองนี้</td></tr>
            )}
            {result?.data.map((item) => (
              <Fragment key={item.id}>
                <tr className={`border-t border-border align-top ${item.enabled ? '' : 'text-ink-soft'}`}>
                  <td className="px-4 py-3 font-medium break-all">{item.term}</td>
                  <td className="px-4 py-3">
                    <Badge className={item.severity === 'HARD' ? 'bg-danger-soft text-danger-text' : 'bg-warning-soft text-warning-text'}>{item.severity}</Badge>
                  </td>
                  <td className="px-4 py-3">{item.weight ?? '—'}</td>
                  <td className="px-4 py-3">{item.category}</td>
                  <td className="px-4 py-3">
                    <button type="button" role="switch" aria-checked={item.enabled} disabled={busy}
                      aria-label={`${item.enabled ? 'ปิด' : 'เปิด'}ใช้งานคำ ${item.term}`}
                      onClick={() => void patch(item.id, { enabled: !item.enabled }, `${item.enabled ? 'ปิด' : 'เปิด'}ใช้งานคำ "${item.term}" แล้ว`)}
                      className={`relative h-6 w-11 rounded-full transition-colors disabled:opacity-50 ${item.enabled ? 'bg-primary' : 'bg-border'}`}>
                      <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-surface shadow transition-all ${item.enabled ? 'left-[1.375rem]' : 'left-0.5'}`} />
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right whitespace-nowrap">
                    {deleteId === item.id ? (
                      <span className="inline-flex items-center gap-2">
                        <button type="button" disabled={busy} onClick={() => void remove(item)} className="rounded-lg bg-danger px-3 py-1.5 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">ยืนยันลบ</button>
                        <button type="button" onClick={() => setDeleteId(null)} className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">ยกเลิก</button>
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-2">
                        <button type="button" onClick={() => { setEditId(editId === item.id ? null : item.id); setEditWeight(String(item.weight ?? '')); setEditCategory(item.category); setEditError(''); }}
                          className="rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">แก้ไข</button>
                        <button type="button" onClick={() => setDeleteId(item.id)} className="rounded-lg border border-border px-3 py-1.5 text-sm text-danger-text hover:bg-danger-soft">ลบ</button>
                      </span>
                    )}
                  </td>
                </tr>
                {editId === item.id && (
                  <tr className="bg-surface-muted">
                    <td colSpan={6} className="px-4 py-4">
                      <form onSubmit={(event) => void submitEdit(event, item)} className="flex flex-wrap items-end gap-3">
                        {item.severity === 'SOFT' && (
                          <label className="w-28 text-sm">
                            <span className="mb-1 block text-xs font-medium text-ink-soft">น้ำหนัก</span>
                            <input value={editWeight} onChange={(event) => setEditWeight(event.target.value)} inputMode="numeric"
                              className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary" />
                          </label>
                        )}
                        <label className="w-48 text-sm">
                          <span className="mb-1 block text-xs font-medium text-ink-soft">หมวด</span>
                          <input value={editCategory} onChange={(event) => setEditCategory(event.target.value)} maxLength={CATEGORY_MAX}
                            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary" />
                        </label>
                        <button type="submit" disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">บันทึก</button>
                        <button type="button" onClick={() => setEditId(null)} className="rounded-lg border border-border px-4 py-2 text-sm hover:bg-surface">ยกเลิก</button>
                        {item.severity === 'HARD' && <p className="w-full text-xs text-ink-soft">คำแบบ HARD ไม่มีน้ำหนัก แก้ได้เฉพาะหมวด</p>}
                      </form>
                      {editError && <div className="mt-2 max-w-xl"><Notice tone="error">{editError}</Notice></div>}
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
          <span>ทั้งหมด {total} คำ · หน้า {filters.page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={filters.page <= 1} onClick={() => update({ page: filters.page - 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ก่อนหน้า</button>
            <button type="button" disabled={filters.page >= lastPage} onClick={() => update({ page: filters.page + 1 })} className="rounded-lg border border-border px-3 py-1.5 disabled:opacity-40">ถัดไป</button>
          </span>
        </div>
      )}
    </div>
  );
}
