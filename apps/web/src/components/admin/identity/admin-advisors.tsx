'use client';

import { useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AdminAdvisorListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { USER_STATUS_LABEL, labelOf } from '@/lib/status-map';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statusOptions: Array<[string, string]> = [['PENDING_APPROVAL', 'รออนุมัติ'], ['ACTIVE', 'ใช้งานอยู่'], ['', 'ทั้งหมด']];

export function AdminAdvisors() {
  const { request } = useAuth();
  const params = useSearchParams();
  const [status, setStatus] = useState(params.get('student') ? 'ACTIVE' : 'PENDING_APPROVAL');
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
    if (!UUID.test(studentId.trim()) || !UUID.test(advisorId.trim())) { setError('รหัสบัญชีนักศึกษาและอาจารย์ต้องเป็น UUID (ไม่ใช่รหัสนักศึกษา)'); return; }
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
            <p className="mt-1 text-xs text-ink-soft">{labelOf(USER_STATUS_LABEL, item.status)} · สมัครเมื่อ {new Date(item.created_at).toLocaleDateString('th-TH')}</p>
            <p className="mt-1 break-all text-xs text-ink-soft">รหัสบัญชี <span className="font-mono">{item.id}</span></p></div>
            {item.status === 'ACTIVE' && <button type="button" onClick={() => { setAdvisorId(item.id); setError(''); document.getElementById('move-student')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }}
              aria-pressed={advisorId.trim() === item.id} className="rounded-lg border border-border px-3 py-2 text-sm aria-pressed:border-primary aria-pressed:text-primary">{advisorId.trim() === item.id ? 'เลือกเป็นอาจารย์ปลายทางแล้ว' : 'เลือกเป็นอาจารย์ปลายทาง'}</button>}
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
    <section id="move-student" className="scroll-mt-4 rounded-xl border border-border bg-surface p-4"><h2 className="text-lg font-semibold">ย้ายอาจารย์ของนักศึกษา</h2>
      <p className="mt-1 text-sm text-ink-soft">ใช้รหัสบัญชี (UUID) ไม่ใช่รหัสนักศึกษา — ค้นนักศึกษาด้วยชื่อ อีเมล หรือรหัสนักศึกษาที่หน้า <a className="text-primary underline" href="/admin/users">ผู้ใช้</a> แล้วกด &quot;ย้ายอาจารย์&quot; ระบบจะเติมรหัสให้ • อาจารย์ปลายทางกด &quot;เลือกเป็นอาจารย์ปลายทาง&quot; ในรายการด้านบน (ตัวกรอง &quot;ใช้งานอยู่&quot;) • เจ้าของบัญชีดูรหัสบัญชีของตนได้ที่หน้าบัญชี • ระบบรับเฉพาะอาจารย์ที่ใช้งานอยู่ในมหาวิทยาลัยเดียวกัน</p>
      <form onSubmit={(event) => void moveStudent(event)} className="mt-4 flex flex-wrap items-end gap-3">
        <label className="min-w-64 flex-1 text-sm">รหัสบัญชีนักศึกษา<input value={studentId} onChange={(event) => setStudentId(event.target.value)} required placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs" /></label>
        <label className="min-w-64 flex-1 text-sm">รหัสบัญชีอาจารย์คนใหม่<input value={advisorId} onChange={(event) => setAdvisorId(event.target.value)} required placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" className="mt-1 w-full rounded-lg border border-border px-3 py-2 font-mono text-xs" /></label>
        <button disabled={busy} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">ย้ายนักศึกษา</button>
      </form>
    </section>
  </div>;
}
