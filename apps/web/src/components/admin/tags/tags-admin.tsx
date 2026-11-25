'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AdminTag, CreateTagRequest, Paginated, UpdateTagRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { Badge } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 50;
const NAME_MAX = 50;

function failure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 409) return 'มี Tag ชื่อนี้อยู่แล้ว (ชื่อที่ต่างกันเฉพาะตัวพิมพ์หรือเครื่องหมายถือว่าซ้ำ)';
    return cause.message;
  }
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

/** จัดการ Tag ทักษะกลาง (api-contract §5.4) — HR เลือกจากรายการนี้ตอนสร้างประกาศ */
export function TagsAdmin() {
  const { request } = useAuth();
  const fieldId = useId();
  const [result, setResult] = useState<Paginated<AdminTag> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [activeFilter, setActiveFilter] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const [newName, setNewName] = useState('');
  const [newError, setNewError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<AdminTag | null>(null);
  const [editActive, setEditActive] = useState(false);
  const [editError, setEditError] = useState('');
  const [editName, setEditName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError('');
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (activeFilter) query.set('active', activeFilter);
    if (q.trim()) query.set('q', q.trim());
    request<Paginated<AdminTag>>(`/admin/tags?${query.toString()}`)
      .then((data) => { if (active) setResult(data); })
      .catch((cause) => { if (active) { setResult(null); setError(failure(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [activeFilter, q, page, reloadKey, request]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  async function create(event: FormEvent) {
    event.preventDefault();
    const name = newName.trim();
    if (!name) { setNewError('กรุณากรอกชื่อ Tag'); return; }
    if (!/[a-z0-9]/i.test(name)) { setNewError('ชื่อ Tag ต้องมีตัวอักษรอังกฤษหรือตัวเลข'); return; }
    if (name.length > NAME_MAX) { setNewError(`ชื่อ Tag ต้องไม่เกิน ${NAME_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setNewError('');
    setNotice('');
    try {
      const body: CreateTagRequest = { name };
      await request<AdminTag>('/admin/tags', { method: 'POST', body });
      setNewName('');
      setNotice(`เพิ่ม Tag "${name}" แล้ว`);
      reload();
    } catch (cause) { setNewError(failure(cause)); }
    finally { setBusy(false); }
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const name = editName.trim();
    if (!/[a-z0-9]/i.test(name)) { setEditError('ชื่อ Tag ต้องมีตัวอักษรอังกฤษหรือตัวเลข'); return; }
    const body: UpdateTagRequest = {};
    if (name !== editing.name) body.name = name;
    if (editActive !== editing.active) body.active = editActive;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await request<AdminTag>(`/admin/tags/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body });
      setNotice(`บันทึก Tag "${name}" แล้ว`);
      dialog.current?.close();
      reload();
    } catch (cause) { setEditError(failure(cause)); }
    finally { setBusy(false); }
  }

  /** ลบได้เฉพาะ Tag ที่ไม่มีประกาศใช้ — API ตอบ 409 TAG_IN_USE ถ้ามีประกาศเพิ่มเข้ามาระหว่างนี้ */
  async function remove() {
    if (!editing || editing.job_count > 0) return;
    if (!window.confirm(`ลบ Tag "${editing.name}" ถาวร? ลบแล้วกู้คืนไม่ได้`)) return;
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await request(`/admin/tags/${encodeURIComponent(editing.id)}`, { method: 'DELETE' });
      setNotice(`ลบ Tag "${editing.name}" แล้ว`);
      dialog.current?.close();
      reload();
    } catch (cause) {
      const inUse = cause instanceof ApiError && cause.issues.includes('TAG_IN_USE');
      setEditError(inUse ? 'มีประกาศใช้ Tag นี้แล้ว ลบไม่ได้ — ปิดใช้งานแทน' : failure(cause));
      if (inUse) reload();
    } finally { setBusy(false); }
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Tag ทักษะ</h1>
      <p className="mt-1 text-sm text-ink-soft">
        รายการกลางที่ HR เลือกติดประกาศงาน (เช่น NextJs, NestJs, Rust) และนักศึกษาใช้กรองการค้นหา การปิดใช้งานทำให้ Tag ไม่ขึ้นให้เลือกใหม่ แต่ประกาศเดิมที่ติด Tag นั้นยังคงอยู่
      </p>

      <details className="mt-4"><summary className="w-fit cursor-pointer font-medium text-primary">เพิ่ม Tag</summary>
      <form onSubmit={(event) => void create(event)} className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">เพิ่ม Tag</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[16rem] flex-1 text-sm">
            <label htmlFor={`${fieldId}-new`} className="mb-1 block text-xs font-medium text-ink-soft">ชื่อ Tag</label>
            <input id={`${fieldId}-new`} aria-required="true" aria-invalid={newError ? true : undefined}
              aria-describedby={newError ? `${fieldId}-new-error` : undefined} value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={NAME_MAX} placeholder="เช่น NextJs"
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </div>
          <button type="submit" disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">เพิ่ม</button>
        </div>
        {newError && <div id={`${fieldId}-new-error`} className="mt-3"><Notice tone="error">{newError}</Notice></div>}
      </form></details>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="สถานะ" value={activeFilter} onChange={(value) => { setActiveFilter(value); setPage(1); }}
          options={[['', 'ทั้งหมด'], ['true', 'ใช้งานอยู่'], ['false', 'ปิดใช้งาน']]} />
        <div className="text-sm">
          <label htmlFor={`${fieldId}-q`} className="mb-1 block text-xs font-medium text-ink-soft">ค้นชื่อ</label>
          <input id={`${fieldId}-q`} type="search" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }}
            className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
        </div>
      </div>

      {notice && <div className="mt-4"><Notice tone="success">{notice}</Notice></div>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      {/* relative: ให้ sr-only (position:absolute) ในหัวตารางอยู่ในกล่องที่เลื่อนได้ ไม่ดันหน้ากว้างเกินจอมือถือ */}
      <div className="relative mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">ชื่อ</th>
              <th scope="col" className="px-4 py-3 font-medium">ประกาศที่ใช้</th>
              <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
              <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">การทำงาน</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && <tr><td colSpan={4} className="px-4 py-8 text-center text-ink-soft">ไม่มี Tag ตามตัวกรองนี้</td></tr>}
            {result?.data.map((tag) => (
              <tr key={tag.id} className="border-t border-border">
                <td className="px-4 py-3 font-medium">
                  {tag.name}
                  <span className="block font-mono text-xs font-normal text-ink-soft [overflow-wrap:anywhere]">{tag.slug}</span>
                </td>
                <td className="px-4 py-3">{tag.job_count}</td>
                <td className="px-4 py-3">
                  <Badge className={tag.active ? 'bg-success-soft text-success-text' : 'bg-surface-muted text-ink-soft'}>{tag.active ? 'ใช้งานอยู่' : 'ปิดใช้งาน'}</Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    <button type="button" aria-label={`จัดการ Tag ${tag.name}`} className="text-sm text-primary"
                      onClick={() => { setEditing(tag); setEditActive(tag.active); setEditName(tag.name); setEditError(''); dialog.current?.showModal(); }}>จัดการ</button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dialog ref={dialog} aria-labelledby={`${fieldId}-edit-title`} className="m-auto w-[min(28rem,90vw)] rounded-xl p-6 backdrop:bg-black/40">
        {editing && <form onSubmit={save} className="space-y-4">
          <h2 id={`${fieldId}-edit-title`} className="text-lg font-semibold">จัดการ Tag</h2>
          <label className="block text-sm">ชื่อ Tag<input required value={editName} maxLength={NAME_MAX} onChange={(event) => setEditName(event.target.value)} aria-invalid={Boolean(editError)} className="mt-1 block w-full rounded-lg border border-border p-2" /></label>
          {editError && <Notice tone="error">{editError}</Notice>}
          <p className="text-sm text-ink-soft">slug · {editing.slug}</p>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={editActive} onChange={(event) => setEditActive(event.target.checked)} />เปิดให้เลือกในประกาศใหม่</label>
          {editing.active && !editActive && <p className="text-sm text-ink-soft">ประกาศเดิมที่ใช้ Tag นี้ยังแสดงได้ตามเดิม</p>}
          <div className="border-t border-border pt-3 text-sm">
            {editing.job_count > 0
              ? <p className="text-ink-soft">ลบไม่ได้ — มีประกาศใช้ Tag นี้ {editing.job_count} รายการ (ปิดใช้งานแทนได้)</p>
              : <button type="button" disabled={busy} onClick={() => void remove()} className="font-medium text-danger-text disabled:opacity-50">ลบ Tag นี้</button>}
          </div>
          <div className="flex justify-end gap-3"><button type="button" disabled={busy} onClick={() => dialog.current?.close()}>ยกเลิก</button>
            <button disabled={busy || !editName.trim() || (editName.trim() === editing.name && editActive === editing.active)} className="rounded-full bg-primary px-4 py-2 text-white disabled:opacity-50">บันทึก</button></div>
        </form>}
      </dialog>
      {result && total > 0 && (
        <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
          <span>ทั้งหมด {total} รายการ · หน้า {page} จาก {lastPage}</span>
          <span className="flex gap-2">
            <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-muted disabled:opacity-50">ก่อนหน้า</button>
            <button type="button" disabled={page >= lastPage} onClick={() => setPage((current) => current + 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-muted disabled:opacity-50">ถัดไป</button>
          </span>
        </div>
      )}
    </div>
  );
}
