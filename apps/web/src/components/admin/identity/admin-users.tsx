'use client';

import { useEffect, useState } from 'react';
import type { AdminUserListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ROLE_LABEL, USER_STATUS_LABEL, labelOf } from '@/lib/status-map';
import { useUniversityOptions } from './use-universities';

const roles: Array<[string, string]> = [['', 'ทุกบทบาท'], ['STUDENT', 'นักศึกษา'], ['ADVISOR', 'อาจารย์'], ['COMPANY_HR', 'HR'], ['PLATFORM_ADMIN', 'Admin']];
const statuses: Array<[string, string]> = [['', 'ทุกสถานะ'], ['ACTIVE', 'ใช้งานอยู่'], ['PENDING_EMAIL', 'รอยืนยันอีเมล'], ['PENDING_APPROVAL', 'รออนุมัติ'], ['SUSPENDED', 'ถูกระงับ']];

export function AdminUsers() {
  const { request } = useAuth();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [universityId, setUniversityId] = useState('');
  const universityOptions = useUniversityOptions();
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<Paginated<AdminUserListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [selectedId, setSelectedId] = useState('');
  const [actionId, setActionId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    setActionId(null);
    const query = new URLSearchParams({ page: String(page) });
    if (q) query.set('q', q);
    if (role) query.set('role', role);
    if (status) query.set('status', status);
    if (universityId) query.set('university_id', universityId);
    request<Paginated<AdminUserListItem>>(`/admin/users?${query}`)
      .then((data) => { if (active) { setResult(data); setError(''); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, q, role, status, universityId, page, reload]);

  async function changeStatus(item: AdminUserListItem) {
    const action = item.status === 'SUSPENDED' ? 'unsuspend' : 'suspend';
    if (action === 'suspend' && !reason.trim()) { setError('กรุณาระบุเหตุผลที่ระงับบัญชี'); return; }
    if (!window.confirm(`${action === 'suspend' ? 'ระงับ' : 'ยกเลิกการระงับ'}บัญชี ${item.full_name} · ${item.email}?`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/users/${item.id}/actions/${action}`, { method: 'POST', body: action === 'suspend' ? { reason: reason.trim() } : {} });
      setNotice(action === 'suspend' ? 'ระงับบัญชีแล้ว' : 'ยกเลิกการระงับบัญชีแล้ว');
      setReason(''); setActionId(null); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'เปลี่ยนสถานะไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  const selected = result?.data.find((item) => item.id === selectedId);
  const lastPage = Math.max(1, Math.ceil((result?.meta.total ?? 0) / 20));
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">ผู้ใช้</h1><p className="mt-1 text-sm text-ink-soft">ค้นหาบัญชี ตรวจสถานะ และจัดการการระงับบัญชี</p></div>
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
      <form onSubmit={(event) => { event.preventDefault(); setQ(search.trim()); setPage(1); }} className="flex min-w-64 flex-1 items-end gap-2">
        <label className="flex-1 text-sm">ชื่อ อีเมล หรือรหัสนักศึกษา<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" /></label>
        <button className="rounded-lg border border-border px-3 py-2 text-sm">ค้นหา</button>
      </form>
      <span className="text-sm text-ink-soft">{result && `พบ ${result.meta.total} บัญชี`}</span>
      {(q || role || status || universityId || search) && <button className="text-sm text-primary" onClick={() => { setQ(''); setSearch(''); setRole(''); setStatus(''); setUniversityId(''); setPage(1); }}>ล้างตัวกรอง</button>}
      <FilterSelect label="บทบาท" value={role} options={roles} onChange={(value) => { setRole(value); setPage(1); }} />
      <FilterSelect label="สถานะ" value={status} options={statuses} onChange={(value) => { setStatus(value); setPage(1); }} />
      <FilterSelect label="มหาวิทยาลัย" value={universityId} options={universityOptions} onChange={(value) => { setUniversityId(value); setPage(1); }} />
    </div>
    <div className="rounded-xl border border-border bg-surface p-4">
      {loading ? <p className="text-sm text-ink-soft">กำลังโหลด…</p> : !result?.data.length ? <p className="text-sm text-ink-soft">ไม่พบบัญชีที่ตรงกับตัวกรอง</p> :
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead className="bg-surface-muted text-ink-soft"><tr>{['ชื่อและอีเมล', 'บทบาท', 'สถานะ', 'มหาวิทยาลัย', 'รหัสนักศึกษา', 'จัดการ'].map((label) => <th key={label} scope="col" className="p-3">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-border">{result.data.map((item) => <tr key={item.id} className={item.id === selectedId ? 'bg-primary-soft' : ''}>
            <th scope="row" className="max-w-xs p-3 [overflow-wrap:anywhere]">{item.full_name}<span className="block font-normal text-ink-soft">{item.email}</span></th>
            <td className="p-3">{labelOf(ROLE_LABEL, item.role)}</td><td className="p-3">{labelOf(USER_STATUS_LABEL, item.status)}</td><td className="p-3">{item.university_name || '—'}</td><td className="p-3">{item.student_code || '—'}</td>
            <td className="p-3"><button aria-label={`จัดการ ${item.full_name} ${item.email}`} onClick={() => { setSelectedId(item.id); setActionId(null); setReason(''); }} className="text-primary">จัดการ</button></td>
          </tr>)}</tbody>
        </table></div>}
      {!loading && selected && <section aria-label="รายละเอียดบัญชีที่เลือก" className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 [overflow-wrap:anywhere]">
        <h2 className="font-semibold">{selected.full_name}</h2>
        <p className="text-sm">{selected.email} · {labelOf(ROLE_LABEL, selected.role)} · {labelOf(USER_STATUS_LABEL, selected.status)}</p>
        <details className="text-xs text-ink-soft"><summary className="cursor-pointer">รหัสอ้างอิงระบบ</summary><p>บัญชี {selected.id}</p>{selected.university_id && <p>มหาวิทยาลัย {selected.university_id}</p>}{selected.advisor_id && <p>อาจารย์ {selected.advisor_id}</p>}</details>
        <div className="flex flex-wrap gap-3 text-sm">
          {selected.role === 'STUDENT' && selected.status === 'ACTIVE' && <a className="text-primary" href={`/admin/advisors?${new URLSearchParams({ student: selected.id, code: selected.student_code || selected.email })}#move-student`}>ย้ายอาจารย์</a>}
          {selected.status === 'ACTIVE' && actionId !== selected.id && <button className="text-danger-text" onClick={() => setActionId(selected.id)}>ระงับบัญชี</button>}
          {selected.status === 'SUSPENDED' && <button disabled={busy} className="text-primary" onClick={() => void changeStatus(selected)}>ยกเลิกการระงับ</button>}
        </div>
        {actionId === selected.id && <form onSubmit={(event) => { event.preventDefault(); void changeStatus(selected); }} className="flex flex-wrap items-end gap-3 text-sm">
          <label>เหตุผลที่ระงับบัญชี<input required maxLength={1000} value={reason} onChange={(event) => setReason(event.target.value)} className="block rounded-lg border border-border p-2" /></label>
          <button disabled={busy || !reason.trim()} className="rounded-lg bg-danger px-3 py-2 text-white">ยืนยันการระงับ</button><button type="button" onClick={() => setActionId(null)}>ยกเลิก</button>
        </form>}
      </section>}
      {lastPage > 1 && <div className="mt-4 flex items-center justify-end gap-3 text-sm"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">ก่อนหน้า</button><span>{page} / {lastPage}</span><button disabled={page >= lastPage} onClick={() => setPage(page + 1)} className="disabled:opacity-40">ถัดไป</button></div>}
    </div>
  </div>;
}
