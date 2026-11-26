'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AdminUniversityItem, UpdateUniversityRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Badge } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';

const NAME_MAX = 200;
const ABBREVIATION = /^[A-Z0-9]{2,10}$/;

function failure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.issues.includes('UNIVERSITY_ABBREVIATION_TAKEN')) return 'ตัวย่อนี้มีมหาวิทยาลัยอื่นใช้แล้ว';
    return cause.message;
  }
  return 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
}

/**
 * จัดการมหาวิทยาลัย (PATCH /admin/universities/{id}) — แก้ชื่อ/ตัวย่อที่สะกดผิด และเปิด/ปิดรับสมัคร
 * มหาวิทยาลัยถูกสร้างจากโดเมนอีเมลตอนอาจารย์คนแรกสมัคร จึงไม่มีปุ่มเพิ่ม/ลบ และโดเมนแก้ไม่ได้
 */
export function AdminUniversities() {
  const { request } = useAuth();
  const fieldId = useId();
  const [items, setItems] = useState<AdminUniversityItem[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reloadKey, setReloadKey] = useState(0);
  const [q, setQ] = useState('');

  const dialog = useRef<HTMLDialogElement>(null);
  const [editing, setEditing] = useState<AdminUniversityItem | null>(null);
  const [name, setName] = useState('');
  const [abbreviation, setAbbreviation] = useState('');
  const [active, setActive] = useState(true);
  const [editError, setEditError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let current = true;
    setLoading(true);
    setError('');
    request<{ data: AdminUniversityItem[] }>('/admin/universities')
      .then((result) => { if (current) setItems(result.data); })
      .catch((cause) => { if (current) { setItems(null); setError(failure(cause)); } })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [reloadKey, request]);

  const reload = useCallback(() => setReloadKey((key) => key + 1), []);

  function open(item: AdminUniversityItem) {
    setEditing(item);
    setName(item.name);
    setAbbreviation(item.abbreviation ?? '');
    setActive(item.active);
    setEditError('');
    dialog.current?.showModal();
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const nextName = name.trim();
    const nextAbbreviation = abbreviation.trim().toUpperCase();
    if (!nextName) { setEditError('กรุณากรอกชื่อมหาวิทยาลัย'); return; }
    if (nextAbbreviation && !ABBREVIATION.test(nextAbbreviation)) { setEditError('ตัวย่อต้องเป็น A-Z หรือ 0-9 ยาว 2–10 ตัว'); return; }
    if (!nextAbbreviation && editing.abbreviation) { setEditError('ลบตัวย่อไม่ได้ — ใส่ตัวย่อที่ถูกต้องแทน'); return; }
    const body: UpdateUniversityRequest = {};
    if (nextName !== editing.name) body.name = nextName;
    if (nextAbbreviation && nextAbbreviation !== editing.abbreviation) body.abbreviation = nextAbbreviation;
    if (active !== editing.active) body.active = active;
    if (!Object.keys(body).length) { dialog.current?.close(); return; }
    setBusy(true);
    setNotice('');
    setEditError('');
    try {
      const saved = await request<AdminUniversityItem>(`/admin/universities/${encodeURIComponent(editing.id)}`, { method: 'PATCH', body });
      setNotice(`บันทึก ${saved.name} แล้ว`);
      dialog.current?.close();
      reload();
    } catch (cause) { setEditError(failure(cause)); }
    finally { setBusy(false); }
  }

  const keyword = q.trim().toLowerCase();
  const shown = (items ?? []).filter((item) => !keyword
    || [item.name, item.email_domain, item.abbreviation ?? ''].some((value) => value.toLowerCase().includes(keyword)));

  return (
    <div>
      <h1 className="text-2xl font-semibold">มหาวิทยาลัย</h1>
      <p className="mt-1 text-sm text-ink-soft">
        ระบบสร้างมหาวิทยาลัยจากโดเมนอีเมลตอนอาจารย์คนแรกสมัคร แก้ชื่อหรือตัวย่อที่สะกดผิดได้ที่นี่ ตัวย่อใหม่ใช้กับรหัสอาจารย์ที่สมัครหลังจากนี้ (รหัสอาจารย์เดิมไม่เปลี่ยน) การปิดใช้งานทำให้อาจารย์โดเมนนี้สมัครใหม่ไม่ได้
      </p>

      <div className="mt-5 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
        <div className="text-sm">
          <label htmlFor={`${fieldId}-q`} className="mb-1 block text-xs font-medium text-ink-soft">ค้นชื่อ ตัวย่อ หรือโดเมน</label>
          <input id={`${fieldId}-q`} type="search" value={q} onChange={(event) => setQ(event.target.value)}
            className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
        </div>
      </div>

      {notice && <div className="mt-4"><Notice tone="success">{notice}</Notice></div>}
      {error && <div className="mt-4"><Notice tone="error">{error}</Notice></div>}

      <div className="relative mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
        <table className="w-full min-w-[640px] text-left text-sm">
          <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">ชื่อ</th>
              <th scope="col" className="px-4 py-3 font-medium">ตัวย่อ</th>
              <th scope="col" className="px-4 py-3 font-medium">โดเมนอีเมล</th>
              <th scope="col" className="px-4 py-3 font-medium">สถานะ</th>
              <th scope="col" className="px-4 py-3 font-medium"><span className="sr-only">การทำงาน</span></th>
            </tr>
          </thead>
          <tbody>
            {loading && !items && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
            {!loading && !error && items && shown.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">ไม่พบมหาวิทยาลัย</td></tr>}
            {shown.map((item) => (
              <tr key={item.id} className="border-t border-border">
                <td className="px-4 py-3 font-medium [overflow-wrap:anywhere]">{item.name}</td>
                <td className="px-4 py-3 font-mono">{item.abbreviation ?? <span className="font-sans text-ink-soft">ยังไม่ตั้ง</span>}</td>
                <td className="px-4 py-3 [overflow-wrap:anywhere]">{item.email_domain}</td>
                <td className="px-4 py-3">
                  <Badge className={item.active ? 'bg-success-soft text-success-text' : 'bg-surface-muted text-ink-soft'}>{item.active ? 'เปิดรับสมัคร' : 'ปิดใช้งาน'}</Badge>
                </td>
                <td className="px-4 py-3 text-right">
                  <button type="button" aria-label={`แก้ไข ${item.name}`} className="text-sm text-primary" onClick={() => open(item)}>แก้ไข</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items && <p className="mt-3 text-sm text-ink-soft">ทั้งหมด {items.length} แห่ง</p>}

      <dialog ref={dialog} aria-labelledby={`${fieldId}-edit-title`} className="m-auto w-[min(28rem,90vw)] rounded-xl p-6 backdrop:bg-black/40">
        {editing && <form onSubmit={(event) => void save(event)} className="space-y-4">
          <h2 id={`${fieldId}-edit-title`} className="text-lg font-semibold">แก้ไขมหาวิทยาลัย</h2>
          <p className="text-sm text-ink-soft">โดเมนอีเมล · {editing.email_domain} (แก้ไม่ได้)</p>
          <label className="block text-sm">ชื่อมหาวิทยาลัย
            <input required value={name} maxLength={NAME_MAX} onChange={(event) => setName(event.target.value)}
              className="mt-1 block w-full rounded-lg border border-border p-2" /></label>
          <label className="block text-sm">ตัวย่อ (A-Z/0-9 2–10 ตัว)
            <input value={abbreviation} maxLength={10} onChange={(event) => setAbbreviation(event.target.value.toUpperCase())}
              className="mt-1 block w-full rounded-lg border border-border p-2 font-mono uppercase" /></label>
          {editing.abbreviation && abbreviation.trim().toUpperCase() !== editing.abbreviation && (
            <p className="text-sm text-ink-soft">รหัสอาจารย์ที่ออกไปแล้ว (ขึ้นต้นด้วย {editing.abbreviation}) จะไม่เปลี่ยน</p>
          )}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />เปิดรับสมัครอาจารย์จากโดเมนนี้</label>
          {editError && <Notice tone="error">{editError}</Notice>}
          <div className="flex justify-end gap-3">
            <button type="button" disabled={busy} onClick={() => dialog.current?.close()}>ยกเลิก</button>
            <button disabled={busy} className="rounded-full bg-primary px-4 py-2 text-white disabled:opacity-50">บันทึก</button>
          </div>
        </form>}
      </dialog>
    </div>
  );
}
