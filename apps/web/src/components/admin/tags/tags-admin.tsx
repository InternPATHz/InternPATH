'use client';

import { useCallback, useEffect, useState } from 'react';
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
  const [editId, setEditId] = useState<string | null>(null);
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

  async function patch(tag: AdminTag, body: UpdateTagRequest, success: string) {
    setBusy(true);
    setNotice('');
    setError('');
    try {
      await request<AdminTag>(`/admin/tags/${encodeURIComponent(tag.id)}`, { method: 'PATCH', body });
      setNotice(success);
      setEditId(null);
      reload();
    } catch (cause) { setError(failure(cause)); }
    finally { setBusy(false); }
  }

  const total = result?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div>
      <h1 className="text-2xl font-semibold">Tag ทักษะ</h1>
      <p className="mt-1 text-sm text-ink-soft">
        รายการกลางที่ HR เลือกติดประกาศงาน (เช่น NextJs, NestJs, Rust) และนักศึกษาใช้กรองการค้นหา การปิดใช้งานทำให้ Tag ไม่ขึ้นให้เลือกใหม่ แต่ประกาศเดิมที่ติด Tag นั้นยังคงอยู่
      </p>

      <form onSubmit={(event) => void create(event)} className="mt-5 rounded-xl border border-border bg-surface p-4">
        <h2 className="text-sm font-semibold">เพิ่ม Tag</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="min-w-[16rem] flex-1 text-sm">
            <span className="mb-1 block text-xs font-medium text-ink-soft">ชื่อ Tag</span>
            <input value={newName} onChange={(event) => setNewName(event.target.value)} maxLength={NAME_MAX} placeholder="เช่น NextJs"
              className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </label>
          <button type="submit" disabled={busy} className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">เพิ่ม</button>
        </div>
        {newError && <div className="mt-3"><Notice tone="error">{newError}</Notice></div>}
      </form>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <FilterSelect label="สถานะ" value={activeFilter} onChange={(value) => { setActiveFilter(value); setPage(1); }}
          options={[['', 'ทั้งหมด'], ['true', 'ใช้งานอยู่'], ['false', 'ปิดใช้งาน']]} />
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">ค้นชื่อ</span>
          <input value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }}
            className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
        </label>
      </div>

      {notice && <div className="mt-4"><Notice tone="success">{notice}</Notice></div>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">ชื่อ</th>
              <th scope="col" className="px-4 py-3 font-medium">slug</th>
              <th scope="col" className="px-4 py-3 font-medium">ประกาศที่ใช้</th>
              <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
              <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">การทำงาน</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !result && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && result && result.data.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">ไม่มี Tag ตามตัวกรองนี้</td></tr>}
            {result?.data.map((tag) => (
              <tr key={tag.id} className="border-t border-border">
                <td className="px-4 py-3 font-medium">
                  {editId === tag.id ? (
                    <input value={editName} onChange={(event) => setEditName(event.target.value)} maxLength={NAME_MAX} aria-label={`ชื่อใหม่ของ ${tag.name}`}
                      className="w-48 rounded-lg border border-border px-2 py-1 text-sm outline-none focus:border-primary" />
                  ) : tag.name}
                </td>
                <td className="px-4 py-3 font-mono text-xs text-ink-soft">{tag.slug}</td>
                <td className="px-4 py-3">{tag.job_count}</td>
                <td className="px-4 py-3">
                  <Badge className={tag.active ? 'bg-success-soft text-success-text' : 'bg-surface-muted text-ink-soft'}>{tag.active ? 'ใช้งานอยู่' : 'ปิดใช้งาน'}</Badge>
                </td>
                <td className="px-4 py-3">
                  <div className="flex flex-wrap justify-end gap-2">
                    {editId === tag.id ? (
                      <>
                        <button type="button" disabled={busy || !editName.trim() || editName.trim() === tag.name}
                          onClick={() => void patch(tag, { name: editName.trim() }, `เปลี่ยนชื่อ Tag เป็น "${editName.trim()}" แล้ว`)}
                          className="rounded-full bg-primary px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">บันทึก</button>
                        <button type="button" onClick={() => setEditId(null)} className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-muted">ยกเลิก</button>
                      </>
                    ) : (
                      <>
                        <button type="button" disabled={busy} onClick={() => { setEditId(tag.id); setEditName(tag.name); }}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-muted disabled:opacity-50">เปลี่ยนชื่อ</button>
                        <button type="button" disabled={busy}
                          onClick={() => void patch(tag, { active: !tag.active }, tag.active ? `ปิดใช้งาน "${tag.name}" แล้ว` : `เปิดใช้งาน "${tag.name}" แล้ว`)}
                          className="rounded-lg border border-border px-3 py-1.5 text-xs hover:bg-surface-muted disabled:opacity-50">{tag.active ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}</button>
                      </>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

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
