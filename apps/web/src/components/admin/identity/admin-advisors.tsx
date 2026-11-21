'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AdminAdvisorListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statusOptions: Array<[string, string]> = [['PENDING_APPROVAL', 'รออนุมัติ'], ['ACTIVE', 'ใช้งานอยู่'], ['', 'ทั้งหมด']];

export function AdminAdvisors() {
  const { request } = useAuth();
  const params = useSearchParams();
  const [status, setStatus] = useState('PENDING_APPROVAL');
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<AdminAdvisorListItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rejectId, setRejectId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [studentId, setStudentId] = useState(params.get('student') ?? '');
  const [advisorId, setAdvisorId] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const query = new URLSearchParams({ page: String(page) });
    if (status) query.set('status', status);
    request<Paginated<AdminAdvisorListItem>>(`/admin/advisors?${query}`)
      .then((data) => { if (active) { setResult(data); setError(''); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'โหลดรายชื่อไม่สำเร็จ'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, status, page, reload]);

  async function decide(id: string, action: 'approve' | 'reject') {
    if (action === 'reject' && !reason.trim()) { setError('กรุณาระบุเหตุผลที่ปฏิเสธ'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/advisors/${id}/actions/${action}`, { method: 'POST', body: action === 'reject' ? { reason: reason.trim() } : {} });
      setNotice(action === 'approve' ? 'อนุมัติอาจารย์แล้ว' : 'ปฏิเสธบัญชีอาจารย์แล้ว');
      setRejectId(null); setReason(''); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  async function moveStudent(event: React.FormEvent) {
    event.preventDefault();
    if (!UUID.test(studentId.trim()) || !UUID.test(advisorId.trim())) { setError('รหัสนักศึกษาและอาจารย์ต้องเป็น UUID'); return; }
    if (studentId.trim() === advisorId.trim()) { setError('กรุณาเลือกบัญชีคนละรายการ'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/students/${studentId.trim()}/advisor`, { method: 'POST', body: { advisor_id: advisorId.trim() } });
      setNotice('ย้ายนักศึกษาไปยังอาจารย์คนใหม่แล้ว'); setStudentId(''); setAdvisorId('');
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ย้ายอาจารย์ไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  const lastPage = Math.max(1, Math.ceil((result?.meta.total ?? 0) / 20));
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">อาจารย์ที่ปรึกษา</h1><p className="mt-1 text-sm text-ink-soft">พิจารณาบัญชีที่ยืนยันอีเมลแล้ว และย้ายนักศึกษาเมื่อจำเป็น</p></div>
    {error && <Notice tone="error">{error}</Notice>}
    {notice && <Notice tone="success">{notice}</Notice>}
    <section className="rounded-xl border border-border bg-surface p-4">
      <div className="flex items-end justify-between gap-3"><h2 className="text-lg font-semibold">บัญชีอาจารย์</h2>
        <FilterSelect label="สถานะ" value={status} options={statusOptions} onChange={(value) => { setStatus(value); setPage(1); }} /></div>
      {loading ? <p className="mt-4 text-sm text-ink-soft">กำลังโหลด…</p> : !result?.data.length ?
        <p className="mt-4 text-sm text-ink-soft">ไม่มีอาจารย์ในสถานะนี้</p> :
        <div className="mt-4 divide-y divide-border">{result.data.map((item) => <div key={item.id} className="py-4 first:pt-0 last:pb-0">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><p className="font-medium">{item.full_name}</p>
            <p className="text-sm text-ink-soft">{item.email}{item.department ? ` · ${item.department}` : ''}</p>
            <p className="mt-1 text-xs text-ink-soft">{item.status} · {new Date(item.created_at).toLocaleDateString('th-TH')}</p></div>
            {item.status === 'PENDING_APPROVAL' && <div className="flex gap-2">
              <button disabled={busy} onClick={() => void decide(item.id, 'approve')} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">อนุมัติ</button>
              <button disabled={busy} onClick={() => { setRejectId(item.id); setReason(''); }} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">ปฏิเสธ</button>
            </div>}</div>
          {rejectId === item.id && <div className="mt-3 flex flex-wrap gap-2"><input aria-label="เหตุผลที่ปฏิเสธ" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder="เหตุผลที่ปฏิเสธ" className="min-w-60 flex-1 rounded-lg border border-border px-3 py-2 text-sm" />
            <button disabled={busy} onClick={() => void decide(item.id, 'reject')} className="rounded-lg bg-danger px-3 py-2 text-sm font-medium text-white disabled:opacity-50">ยืนยันการปฏิเสธ</button>
            <button onClick={() => setRejectId(null)} className="rounded-lg border border-border px-3 py-2 text-sm">ยกเลิก</button></div>}
        </div>)}</div>}
      <div className="mt-4 flex items-center justify-end gap-3 text-sm"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">ก่อนหน้า</button><span>{page} / {lastPage}</span><button disabled={page >= lastPage} onClick={() => setPage(page + 1)} className="disabled:opacity-40">ถัดไป</button></div>
    </section>
    <section className="rounded-xl border border-border bg-surface p-4"><h2 className="text-lg font-semibold">ย้ายอาจารย์ของนักศึกษา</h2>
      <p className="mt-1 text-sm text-ink-soft">ค้นหารหัสบัญชีจากหน้า <a className="text-primary underline" href="/admin/users">ผู้ใช้</a> ระบบรับเฉพาะอาจารย์ที่ใช้งานอยู่ในมหาวิทยาลัยเดียวกัน</p>
      <form onSubmit={(event) => void moveStudent(event)} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 text-sm">รหัสนักศึกษา<input value={studentId} onChange={(event) => setStudentId(event.target.value)} required className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs" /></label>
        <label className="min-w-64 flex-1 text-sm">รหัสอาจารย์คนใหม่<input value={advisorId} onChange={(event) => setAdvisorId(event.target.value)} required className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs" /></label>
        <button disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">ย้ายนักศึกษา</button>
      </form>
    </section>
  </div>;
}
