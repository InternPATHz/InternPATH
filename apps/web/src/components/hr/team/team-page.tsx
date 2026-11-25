'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { CompanyInvitationItem, CompanyMemberItem, Paginated, JobCategory, OwnerTransferPendingResponse, UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { ApiError } from '@/lib/api';
import { CATEGORIES } from '@/lib/categories';

const CATEGORY_LABEL = Object.fromEntries(CATEGORIES.map((entry) => [entry.id, entry.label])) as Record<JobCategory, string>;
const toggle = (list: JobCategory[], id: JobCategory) => (list.includes(id) ? list.filter((item) => item !== id) : [...list, id]);

/** เลือกสายงาน 1–3 ค่า (README 5.6) */
function CategoryPicker({ value, onChange, disabled, label }: { value: JobCategory[]; onChange: (next: JobCategory[]) => void; disabled?: boolean; label: string }) {
  return (
    <fieldset className="flex flex-wrap gap-2" disabled={disabled}>
      <legend className="sr-only">{label}</legend>
      {CATEGORIES.map((entry) => {
        const on = value.includes(entry.id);
        return (
          <label key={entry.id} className={`cursor-pointer rounded-full border px-3 py-1 text-xs ${on ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-soft'}`}>
            <input type="checkbox" className="sr-only" checked={on} onChange={() => onChange(toggle(value, entry.id))} />
            {entry.label}
          </label>
        );
      })}
    </fieldset>
  );
}

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const PUBLIC_DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com'];

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'PUBLIC_EMAIL_NOT_ALLOWED') return 'เชิญได้เฉพาะอีเมลโดเมนขององค์กร ไม่รับอีเมลสาธารณะ';
  return cause.message;
}

/**
 * ทีม HR ของบริษัท (api-contract §4.3): ดูสมาชิก — Owner เชิญ (อีเมลโดเมนองค์กร + สายงาน), กำหนดสายงานของสมาชิก, ลบสมาชิก, โอนสิทธิ์ Owner
 * สมาชิกเห็นและจัดการใบสมัครเฉพาะประกาศในสายงานของตน (Owner ทุกสายงาน — ปรับ Requirement 2026-11-21)
 */
export function TeamPage() {
  const { request, user } = useAuth();
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [members, setMembers] = useState<CompanyMemberItem[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [transfer, setTransfer] = useState<OwnerTransferPendingResponse | null>(null);
  const [invitations, setInvitations] = useState<CompanyInvitationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [pendingError, setPendingError] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');
  const [inviteCategories, setInviteCategories] = useState<JobCategory[]>([]);
  const [editing, setEditing] = useState<{ userId: string; categories: JobCategory[] } | null>(null);

  const sequence = useRef(0);
  const load = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const [me, list] = await Promise.all([request<UserMeResponse>('/users/me'), request<Paginated<CompanyMemberItem>>(`/companies/me/members?page=${page}&page_size=20`)]);
      if (sequence.current !== version) return;
      const owner = me.company?.member_role === 'OWNER';
      setIsOwner(owner);
      setMembers(list.data);
      setTotal(list.meta.total);
      if (!list.data.length && page > 1) setPage(Math.max(1, Math.ceil(list.meta.total / 20)));
      const [pending, invites] = await Promise.allSettled([
        request<OwnerTransferPendingResponse>('/companies/me/owner-transfer'),
        owner ? request<{ data: CompanyInvitationItem[] }>('/companies/me/invitations') : Promise.resolve({ data: [] }),
      ]);
      if (sequence.current !== version) return;
      setTransfer(pending.status === 'fulfilled' ? pending.value : null);
      setInvitations(invites.status === 'fulfilled' ? invites.value.data : []);
      const transferError = pending.status === 'rejected' && !(pending.reason instanceof ApiError && pending.reason.status === 404);
      setPendingError(transferError || invites.status === 'rejected');
      setLoadError(null);
    } catch (cause) { if (sequence.current === version) setLoadError(failure(cause)); }
    finally { if (sequence.current === version) setLoaded(true); }
  }, [request, page]);

  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); await load(); setMessage({ tone: 'success', text: success }); }
    catch (cause) { setMessage({ tone: 'error', text: failure(cause) }); }
    finally { setBusy(false); }
  }

  function invite(event: FormEvent) {
    event.preventDefault();
    const value = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) { setMessage({ tone: 'error', text: 'รูปแบบอีเมลไม่ถูกต้อง' }); return; }
    if (PUBLIC_DOMAINS.includes(value.split('@')[1])) { setMessage({ tone: 'error', text: 'เชิญได้เฉพาะอีเมลโดเมนขององค์กร ไม่รับอีเมลสาธารณะ' }); return; }
    if (inviteCategories.length === 0) { setMessage({ tone: 'error', text: 'เลือกสายงานของสมาชิกใหม่อย่างน้อย 1 สายงาน' }); return; }
    void run(async () => {
      await request('/companies/me/invitations', { method: 'POST', body: { email: value, categories: inviteCategories } });
      setEmail('');
      setInviteCategories([]);
    }, `ส่งคำเชิญไปที่ ${value} แล้ว (ลิงก์ใช้ได้ครั้งเดียว)`);
  }

  function saveCategories() {
    if (!editing) return;
    if (editing.categories.length === 0) { setMessage({ tone: 'error', text: 'สมาชิกต้องมีอย่างน้อย 1 สายงาน' }); return; }
    const target = editing;
    const member = members.find((person) => person.user_id === target.userId);
    if (!member || !window.confirm(`บันทึกสายงานให้ ${member.full_name} · ${member.email}?`)) return;
    void run(async () => {
      await request(`/companies/me/members/${encodeURIComponent(target.userId)}/categories`, { method: 'PUT', body: { categories: target.categories } });
      setEditing(null);
    }, 'บันทึกสายงานแล้ว มีผลเมื่อสมาชิกเข้าสู่ระบบใหม่');
  }

  if (loadError) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><Notice tone="error">{loadError}</Notice></main>;
  if (!loaded) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ทีม HR</h1>
      <p className="mt-2 text-sm text-ink-soft">สมาชิกจัดการผู้สมัครได้เฉพาะประกาศในสายงานที่ได้รับกำหนด ส่วน Owner เห็นทุกสายงาน และเป็นผู้จัดการข้อมูลบริษัทกับสมาชิก</p>
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {pendingError && <div className="mt-4"><Notice tone="error">โหลดคำเชิญหรือคำขอโอนสิทธิ์ไม่สำเร็จ <button className="underline" onClick={() => void load()}>ลองอีกครั้ง</button></Notice></div>}

      {transfer && (
        <section aria-labelledby="transfer-title" className={`mt-6 rounded-xl p-5 ${transfer.direction === 'INCOMING' ? 'bg-tile text-white' : 'bg-surface-muted'}`}>
          <h2 id="transfer-title" className="text-lg font-semibold">คำขอโอนสิทธิ์ Owner</h2>
          <p className="mt-2 text-sm">{transfer.direction === 'INCOMING'
            ? `${transfer.other_user.full_name} ขอให้คุณรับสิทธิ์ Owner`
            : `รอ ${transfer.other_user.full_name} ตอบรับคำขอ`}</p>
          <div className="mt-4 flex flex-wrap gap-3">
            {transfer.direction === 'INCOMING' ? (
              <>
                <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/owner-transfer/actions/accept', { method: 'POST' }), 'รับสิทธิ์ Owner แล้ว กรุณาเข้าสู่ระบบใหม่เพื่อให้สิทธิ์อัปเดต')}
                  className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ยืนยันรับสิทธิ์ Owner</button>
                <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/owner-transfer/actions/decline', { method: 'POST' }), 'ปฏิเสธคำขอแล้ว')}
                  className="rounded-full border border-white/30 px-5 py-2 text-sm font-semibold disabled:opacity-60">ปฏิเสธ</button>
              </>
            ) : (
              <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/owner-transfer/actions/cancel', { method: 'POST' }), 'ยกเลิกคำขอโอนสิทธิ์แล้ว')}
                className="rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-60">ยกเลิกคำขอ</button>
            )}
          </div>
        </section>
      )}

      {isOwner && (
        <section aria-labelledby="invite-title" className="mt-6 rounded-xl border border-border p-5">
          <h2 id="invite-title" className="text-lg font-semibold">เชิญสมาชิกใหม่</h2>
          <p className="mt-1 text-sm text-ink-soft">ใช้อีเมลโดเมนขององค์กรเท่านั้น และเลือกสายงานที่สมาชิกจะดูแล (1–3 สายงาน) ผู้ได้รับเชิญจะได้ลิงก์ทางอีเมลเพื่อตั้งรหัสผ่านและเข้าร่วมทีม</p>
          <div className="mt-3"><CategoryPicker label="สายงานของสมาชิกใหม่" value={inviteCategories} onChange={setInviteCategories} disabled={busy} /></div>
          <form onSubmit={invite} noValidate className="mt-3 flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 text-sm"><span className="sr-only">อีเมลที่จะเชิญ</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.co.th" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
            </label>
            <button type="submit" disabled={busy} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ส่งคำเชิญ</button>
          </form>
        </section>
      )}

      <section aria-labelledby="members-title" className="mt-6">
        <h2 id="members-title" className="text-lg font-semibold">สมาชิก ({total})</h2>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {members.map((member) => {
            const self = member.user_id === user?.id;
            return (
              <li key={member.user_id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
                <Avatar name={member.full_name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{member.full_name}{self && ' (คุณ)'} <span className="ml-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-soft">{member.member_role === 'OWNER' ? 'Owner' : 'สมาชิก'}</span></p>
                  <p className="truncate text-xs text-ink-soft">{member.email} · เข้าร่วม {dateFormat.format(new Date(member.joined_at))}</p>
                  {editing?.userId === member.user_id ? (
                    <div className="mt-2 flex flex-wrap items-center gap-3">
                      <CategoryPicker label={`สายงานของ ${member.full_name}`} value={editing.categories} disabled={busy}
                        onChange={(categories) => setEditing({ userId: member.user_id, categories })} />
                      <button type="button" disabled={busy} onClick={saveCategories} className="text-xs font-semibold text-primary hover:underline disabled:opacity-60">บันทึก</button>
                      <button type="button" onClick={() => setEditing(null)} className="text-xs text-ink-soft hover:underline">ยกเลิก</button>
                    </div>
                  ) : (
                    <p className="mt-1 text-xs text-ink-soft">สายงาน: {member.member_role === 'OWNER' ? 'ทุกสายงาน' : (member.categories ?? []).map((id) => CATEGORY_LABEL[id] ?? id).join(', ') || 'ยังไม่กำหนด'}</p>
                  )}
                </div>
                {isOwner && member.member_role !== 'OWNER' && (
                  <div className="flex gap-3">
                    <button type="button" disabled={busy} onClick={() => setEditing({ userId: member.user_id, categories: [...(member.categories ?? [])] })}
                      className="font-medium text-primary hover:underline disabled:opacity-60">กำหนดสายงาน</button>
                    <button type="button" disabled={busy} onClick={() => { if (window.confirm(`โอนสิทธิ์ Owner ให้ ${member.full_name} · ${member.email}? ผู้รับต้องกดยืนยันก่อนจึงจะมีผล`)) void run(() => request('/companies/me/owner-transfer', { method: 'POST', body: { to_user_id: member.user_id } }), 'ส่งคำขอโอนสิทธิ์แล้ว รอผู้รับยืนยัน'); }}
                      className="font-medium text-primary hover:underline disabled:opacity-60">โอนสิทธิ์ Owner</button>
                    <button type="button" disabled={busy} onClick={() => { if (window.confirm(`ลบ ${member.full_name} · ${member.email} ออกจากทีม?`)) void run(() => request(`/companies/me/members/${encodeURIComponent(member.user_id)}`, { method: 'DELETE' }), 'ลบสมาชิกแล้ว'); }}
                      className="font-medium text-danger-text hover:underline disabled:opacity-60">ลบ</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        {total > 20 && <nav aria-label="หน้าสมาชิก" className="mt-3 flex items-center gap-3 text-sm"><button disabled={page <= 1} onClick={() => setPage(page - 1)}>ก่อนหน้า</button><span>หน้า {page} จาก {Math.ceil(total / 20)}</span><button disabled={page * 20 >= total} onClick={() => setPage(page + 1)}>ถัดไป</button></nav>}
      </section>

      {isOwner && invitations.length > 0 && (
        <section className="mt-6">
          <h2 className="text-lg font-semibold">คำเชิญที่ยังรอตอบรับ</h2>
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {invitations.map((item) => (
              <li key={item.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span className="min-w-0 break-all text-sm">{item.email} · หมดอายุ {dateFormat.format(new Date(item.expires_at))}</span>
                <button type="button" disabled={busy} onClick={() => {
                  if (window.confirm(`ยกเลิกคำเชิญของ ${item.email}? ลิงก์เดิมจะใช้ไม่ได้`)) void run(
                    () => request(`/companies/me/invitations/${encodeURIComponent(item.id)}`, { method: 'DELETE' }), 'ยกเลิกคำเชิญแล้ว',
                  );
                }} className="text-sm font-medium text-danger-text hover:underline">ยกเลิกคำเชิญ</button>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
