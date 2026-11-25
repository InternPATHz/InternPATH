'use client';

import { useEffect, useState } from 'react';
import type { AdminCompanyDetail, AdminCompanyListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { externalHref } from '@/lib/external-url';

type Action = 'verify' | 'need-more-info' | 'reject' | 'suspend' | 'unsuspend';
const statusOptions: Array<[string, string]> = [['PENDING', 'รอตรวจ'], ['NEED_MORE_INFO', 'รอเอกสารเพิ่ม'], ['VERIFIED', 'ผ่านการตรวจ'], ['REJECTED', 'ปฏิเสธ'], ['SUSPENDED', 'ระงับ'], ['', 'ทั้งหมด']];
const actionLabels: Record<Action, string> = { verify: 'อนุมัติ', 'need-more-info': 'ขอข้อมูลเพิ่ม', reject: 'ปฏิเสธ', suspend: 'ระงับ', unsuspend: 'ยกเลิกการระงับ' };
const availableActions: Record<string, Action[]> = { PENDING: ['verify', 'need-more-info', 'reject'], VERIFIED: ['suspend'], SUSPENDED: ['unsuspend'] };

export function AdminCompanies() {
  const { request } = useAuth();
  const [status, setStatus] = useState('PENDING');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<Paginated<AdminCompanyListItem> | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AdminCompanyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<Action | null>(null);
  const [reason, setReason] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    setLoading(true);
    const query = new URLSearchParams({ page: String(page) });
    if (status) query.set('status', status);
    request<Paginated<AdminCompanyListItem>>(`/admin/companies?${query}`)
      .then((data) => { if (active) { setResult(data); setError(''); } })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'โหลดบริษัทไม่สำเร็จ'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [request, status, page, reload]);

  useEffect(() => {
    if (!selectedId) { setDetail(null); return; }
    let active = true;
    request<AdminCompanyDetail>(`/admin/companies/${selectedId}`)
      .then((data) => { if (active) { setDetail(data); setError(''); } })
      .catch((cause) => { if (active) { setDetail(null); setError(cause instanceof Error ? cause.message : 'โหลดรายละเอียดไม่สำเร็จ'); } });
    return () => { active = false; };
  }, [request, selectedId, reload]);

  async function runAction() {
    if (!selectedId || !action) return;
    if (['need-more-info', 'reject', 'suspend'].includes(action) && !reason.trim()) { setError('กรุณาระบุเหตุผล'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/companies/${selectedId}/actions/${action}`, { method: 'POST', body: reason.trim() ? { reason: reason.trim() } : {} });
      setNotice(`${actionLabels[action]}บริษัทแล้ว`); setAction(null); setReason(''); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  async function updateFlag(path: string, body: unknown, success: string) {
    if (!selectedId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/companies/${selectedId}/${path}`, { method: 'PUT', body });
      setNotice(success); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'บันทึกไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  async function appointOwner(event: React.FormEvent) {
    event.preventDefault();
    if (!selectedId) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/companies/${selectedId}/owner`, { method: 'POST', body: { user_id: ownerId.trim() } });
      setNotice('แต่งตั้ง Owner แล้ว'); setOwnerId(''); setReload((value) => value + 1);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'แต่งตั้ง Owner ไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  const lastPage = Math.max(1, Math.ceil((result?.meta.total ?? 0) / 20));
  return <div className="space-y-5">
    <div><h1 className="text-2xl font-semibold">บริษัท</h1><p className="mt-1 text-sm text-ink-soft">ตรวจเอกสาร อนุมัติสถานะ และจัดการสิทธิ์ของบริษัท</p></div>
    {error && <Notice tone="error">{error}</Notice>}{notice && <Notice tone="success">{notice}</Notice>}
    <div className="grid gap-5 xl:grid-cols-[minmax(280px,1fr)_minmax(0,2fr)]">
      <section className="rounded-xl border border-border bg-surface p-4">
        <div className="flex items-end justify-between gap-3"><h2 className="text-lg font-semibold">รายชื่อบริษัท</h2><FilterSelect label="สถานะ" value={status} options={statusOptions} onChange={(value) => { setStatus(value); setPage(1); }} /></div>
        {loading ? <p className="mt-4 text-sm text-ink-soft">กำลังโหลด…</p> : !result?.data.length ? <p className="mt-4 text-sm text-ink-soft">ไม่มีบริษัทในสถานะนี้</p> :
          <div className="mt-4 divide-y divide-border">{result.data.map((item) => <button key={item.id} onClick={() => { setSelectedId(item.id); setAction(null); setReason(''); }}
            className={`block w-full py-3 text-left first:pt-0 last:pb-0 ${selectedId === item.id ? 'text-primary' : ''}`}>
            <span className="block font-medium">{item.name}</span><span className="block text-xs text-ink-soft">{item.registration_no} · {item.status}</span></button>)}</div>}
        <div className="mt-4 flex items-center justify-end gap-3 text-sm"><button disabled={page <= 1} onClick={() => setPage(page - 1)} className="disabled:opacity-40">ก่อนหน้า</button><span>{page} / {lastPage}</span><button disabled={page >= lastPage} onClick={() => setPage(page + 1)} className="disabled:opacity-40">ถัดไป</button></div>
      </section>
      <section className="rounded-xl border border-border bg-surface p-4">
        {!selectedId ? <p className="text-sm text-ink-soft">เลือกบริษัทเพื่อดูรายละเอียดและดำเนินการ</p> : !detail ? <p className="text-sm text-ink-soft">กำลังโหลดรายละเอียด…</p> : <div className="space-y-5">
          <div><h2 className="text-xl font-semibold">{detail.name}</h2><p className="mt-1 text-sm text-ink-soft">{detail.status} · เลขทะเบียน {detail.registration_no} · {detail.email_domain}</p>
            {detail.review_note && <p className="mt-2 text-sm">หมายเหตุ: {detail.review_note}</p>}
            <p className="mt-2 text-sm">{externalHref(detail.website) && <a href={externalHref(detail.website)} target="_blank" rel="noreferrer" className="text-primary underline">เว็บไซต์บริษัท</a>}{detail.phone && ` · โทร ${detail.phone}`}</p></div>
          <div><h3 className="font-semibold">เอกสาร</h3>{detail.documents.length ? <ul className="mt-2 space-y-1 text-sm">{detail.documents.map((doc) => <li key={doc.id}><a href={doc.url} target="_blank" rel="noreferrer" className="text-primary underline">{doc.doc_type}</a> <span className="text-ink-soft">({Math.ceil(doc.size_bytes / 1024)} KB)</span></li>)}</ul> : <p className="mt-1 text-sm text-ink-soft">ยังไม่มีเอกสาร</p>}</div>
          <div><h3 className="font-semibold">สมาชิก HR</h3>{detail.members.length ? <ul className="mt-2 space-y-2 text-sm">{detail.members.map((member) => <li key={member.user_id}>
            <span>{member.full_name} · {member.email} · {member.member_role}</span>
            <span className="block break-all font-mono text-xs text-ink-soft">{member.user_id}</span>
            {!detail.members.some((entry) => entry.member_role === 'OWNER') && <button onClick={() => setOwnerId(member.user_id)} className="mt-1 text-xs text-primary underline">เลือกเป็น Owner</button>}
          </li>)}</ul> : <p className="mt-1 text-sm text-ink-soft">ยังไม่มีสมาชิก</p>}</div>
          <div><h3 className="font-semibold">พิจารณาสถานะ</h3><div className="mt-2 flex flex-wrap gap-2">{(availableActions[detail.status] ?? []).map((choice) => <button key={choice} disabled={busy} onClick={() => { setAction(choice); setReason(''); }} className="rounded-lg border border-border px-3 py-2 text-sm disabled:opacity-50">{actionLabels[choice]}</button>)}</div>
            {action && <div className="mt-3 space-y-2"><p className="text-sm">{actionLabels[action]}บริษัทนี้</p><input aria-label="เหตุผล" value={reason} onChange={(event) => setReason(event.target.value)} maxLength={1000} placeholder={['need-more-info', 'reject', 'suspend'].includes(action) ? 'เหตุผล (จำเป็น)' : 'หมายเหตุ (ถ้ามี)'} className="w-full rounded-lg border border-border px-3 py-2 text-sm" />
              <div className="flex gap-2"><button disabled={busy} onClick={() => void runAction()} className="rounded-lg bg-primary px-3 py-2 text-sm font-medium text-white disabled:opacity-50">ยืนยัน</button><button onClick={() => setAction(null)} className="rounded-lg border border-border px-3 py-2 text-sm">ยกเลิก</button></div></div>}</div>
          <div className="border-t border-border pt-4"><h3 className="font-semibold">ป้ายและสิทธิ์พิเศษ</h3><div className="mt-2 flex flex-wrap gap-2 text-sm">
            <button disabled={busy} onClick={() => void updateFlag('university-partner', { enabled: !detail.university_partner }, 'อัปเดตป้าย University Partner แล้ว')} className="rounded-lg border border-border px-3 py-2 disabled:opacity-50">University Partner: {detail.university_partner ? 'เปิด' : 'ปิด'}</button>
            <button disabled={busy} onClick={() => void updateFlag('entitlements', { featured_enabled: !detail.featured_enabled, fast_track_enabled: detail.fast_track_enabled }, 'อัปเดต Featured แล้ว')} className="rounded-lg border border-border px-3 py-2 disabled:opacity-50">Featured: {detail.featured_enabled ? 'เปิด' : 'ปิด'}</button>
            <button disabled={busy} onClick={() => void updateFlag('entitlements', { featured_enabled: detail.featured_enabled, fast_track_enabled: !detail.fast_track_enabled }, 'อัปเดต Fast Track แล้ว')} className="rounded-lg border border-border px-3 py-2 disabled:opacity-50">Fast Track: {detail.fast_track_enabled ? 'เปิด' : 'ปิด'}</button></div></div>
          {!detail.members.some((member) => member.member_role === 'OWNER') && <form onSubmit={(event) => void appointOwner(event)} className="border-t border-border pt-4"><h3 className="font-semibold">แต่งตั้ง Owner</h3><p className="mt-1 text-sm text-ink-soft">ใช้รหัสสมาชิก HR ของบริษัทนี้</p><div className="mt-2 flex flex-wrap gap-2"><input value={ownerId} onChange={(event) => setOwnerId(event.target.value)} required placeholder="รหัสผู้ใช้ (UUID)" className="min-w-60 flex-1 rounded-lg border border-border px-3 py-2 font-mono text-xs" /><button disabled={busy} className="rounded-lg bg-primary px-3 py-2 text-sm text-white disabled:opacity-50">แต่งตั้ง</button></div></form>}
        </div>}
      </section>
    </div>
  </div>;
}
