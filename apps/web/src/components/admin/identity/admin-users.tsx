'use client';

import { useEffect, useState } from 'react';
import type { AdminUserListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ROLE_LABEL, USER_STATUS_LABEL, labelOf } from '@/lib/status-map';

const roles: Array<[string, string]> = [['', 'ทุกบทบาท'], ['STUDENT', 'นักศึกษา'], ['ADVISOR', 'อาจารย์'], ['COMPANY_HR', 'HR'], ['PLATFORM_ADMIN', 'Admin']];
const statuses: Array<[string, string]> = [['', 'ทุกสถานะ'], ['ACTIVE', 'ใช้งานอยู่'], ['PENDING_EMAIL', 'รอยืนยันอีเมล'], ['PENDING_APPROVAL', 'รออนุมัติ'], ['SUSPENDED', 'ถูกระงับ']];

export function AdminUsers() {
  const { request } = useAuth();
  const [q, setQ] = useState('');
  const [search, setSearch] = useState('');
  const [role, setRole] = useState('');
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<Paginated<AdminUserListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionId, setActionId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const query = new URLSearchParams({ page: String(page) });
    if (q) query.set('q', q);
    if (role) query.set('role', role);
    if (status) query.set('status', status);
    request<Paginated<AdminUserListItem>>(`/admin/users?${query}`)
      .then((data) => { if (active) { setResult(data); setError(''); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'โหลดรายชื่อผู้ใช้ไม่สำเร็จ'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, q, role, status, page, reload]);

  async function changeStatus(item: AdminUserListItem) {
    const action = item.status === 'SUSPENDED' ? 'unsuspend' : 'suspend';
    if (action === 'suspend' && !reason.trim()) { setError('กรุณาระบุเหตุผลที่ระงับบัญชี'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/users/${item.id}/actions/${action}`, { method: 'POST', body: action === 'suspend' ? { reason: reason.trim() } : {} });
      setNotice(action === 'suspend' ? 'ระงับบัญชีแล้ว' : 'ยกเลิกการระงับบัญชีแล้ว');
      setReason(''); setActionId(null); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'เปลี่ยนสถานะไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  const lastPage = Math.max(1, Math.ceil((result?.meta.total ?? 0) / 20));
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">ผู้ใช้</h1><p className="mt-1 text-sm text-ink-soft">ค้นหาบัญชี ตรวจสถานะ และจัดการการระงับบัญชี</p></div>
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    <div className="flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
      <form onSubmit={(event) => { event.preventDefault(); setQ(search.trim()); setPage(1); }} className="flex min-w-64 flex-1 items-end gap-2">
        <label className="flex-1 text-sm">ชื่อ อีเมล หรือรหัสนักศึกษา<input value={search} onChange={(event) => setSearch(event.target.value)} maxLength={100} className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" /></label>
        <button className="rounded-lg border border-border px-3 py-2 text-sm">ค้นหา</button>
      </form>
      <FilterSelect label="บทบาท" value={role} options={roles} onChange={(value) => { setRole(value); setPage(1); }} />
      <FilterSelect label="สถานะ" value={status} options={statuses} onChange={(value) => { setStatus(value); setPage(1); }} />
    </div>
    <div className="rounded-xl border border-border bg-surface p-4">
      {loading ? <p className="text-sm text-ink-soft">กำลังโหลด…</p> : !result?.data.length ? <p className="text-sm text-ink-soft">ไม่พบบัญชีที่ตรงกับตัวกรอง</p> :
        <div className="divide-y divide-border">{result.data.map((item) => <div key={item.id} className="py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-3"><div className="min-w-0"><p className="font-medium">{item.full_name}</p>
            <p className="text-sm text-ink-soft">{item.email}</p><p className="mt-1 text-xs text-ink-soft">{labelOf(ROLE_LABEL, item.role)} · {labelOf(USER_STATUS_LABEL, item.status)}{item.student_code ? ` · รหัสนักศึกษา ${item.student_code}` : ''}</p>
            <p className="mt-1 break-all text-xs text-ink-soft">รหัสบัญชี <span className="font-mono">{item.id}</span></p>
            {/* API ส่งแค่รหัสบัญชีอาจารย์ (ไม่มีชื่อ) — ใช้รหัสนี้ในฟอร์มย้ายอาจารย์ */}
            {item.advisor_id && <p className="mt-1 break-all text-xs text-ink-soft">รหัสบัญชีอาจารย์ที่ปรึกษา <span className="font-mono">{item.advisor_id}</span></p>}</div>
            <div className="flex gap-2">{item.role === 'STUDENT' && item.status === 'ACTIVE' && <a href={`/admin/advisors?${new URLSearchParams({ student: item.id, code: item.student_code ?? '' })}#move-student`} className="rounded-lg border border-border px-3 py-2 text-sm">ย้ายอาจารย์</a>}
              {(item.status === 'ACTIVE' || item.status === 'SUSPENDED') && <button disabled={busy} onClick={() => { if (item.status === 'SUSPENDED') void changeStatus(item); else { setActionId(item.id); setReason(''); } }} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{item.status === 'SUSPENDED' ? 'ยกเลิกการระงับ' : 'ระงับ'}</button>}</div></div>
          {actionId === item.id && <div className="mt-3 flex flex-wrap gap-2"><input aria-label="เหตุผลที่ระงับบัญชี" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder="เหตุผลที่ระงับบัญชี" className="min-w-60 flex-1 rounded-lg border border-border px-3 py-2 text-sm" />
            <button disabled={busy} onClick={() => void changeStatus(item)} className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50">ยืนยันการระงับ</button>
            <button onClick={() => setActionId(null)} className="rounded-lg border border-border px-3 py-2 text-sm">ยกเลิก</button></div>}
        </div>)}</div>}
      <div className="mt-4 flex items-center justify-end gap-3 text-sm"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">ก่อนหน้า</button><span>{page} / {lastPage}</span><button disabled={page >= lastPage} onClick={() => setPage(page + 1)} className="disabled:opacity-40">ถัดไป</button></div>
    </div>
  </div>;
}
