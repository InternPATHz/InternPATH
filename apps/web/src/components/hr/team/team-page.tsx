'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CompanyMemberItem, UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { ApiError } from '@/lib/api';
import { asList } from '@/lib/list';

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const PUBLIC_DOMAINS = ['gmail.com', 'hotmail.com', 'outlook.com', 'yahoo.com', 'icloud.com', 'live.com', 'proton.me', 'protonmail.com'];

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'PUBLIC_EMAIL_NOT_ALLOWED') return 'เชิญได้เฉพาะอีเมลโดเมนขององค์กร ไม่รับอีเมลสาธารณะ';
  return cause.message;
}

/**
 * ทีม HR ของบริษัท (api-contract §4.3): ดูสมาชิก — Owner เชิญ (อีเมลโดเมนองค์กร), ลบสมาชิก, โอนสิทธิ์ Owner
 * หมายเหตุสัญญา: ยังไม่มี endpoint อ่านรายการคำเชิญค้างหรือคำขอโอนสิทธิ์ที่รออยู่ — หน้านี้จึงแจ้งผลเฉพาะตอนกดเท่านั้น
 */
export function TeamPage() {
  const { request, user } = useAuth();
  const [members, setMembers] = useState<CompanyMemberItem[]>([]);
  const [isOwner, setIsOwner] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [email, setEmail] = useState('');

  const load = useCallback(async () => {
    try {
      const [me, list] = await Promise.all([request<UserMeResponse>('/users/me'), request<CompanyMemberItem[] | { data: CompanyMemberItem[] }>('/companies/me/members')]);
      setIsOwner(me.company?.member_role === 'OWNER');
      setMembers(asList(list as never));
      setLoadError(null);
    } catch (cause) { setLoadError(failure(cause)); }
    finally { setLoaded(true); }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

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
    void run(async () => { await request('/companies/me/invitations', { method: 'POST', body: { email: value } }); setEmail(''); }, `ส่งคำเชิญไปที่ ${value} แล้ว (ลิงก์ใช้ได้ครั้งเดียว)`);
  }

  if (loadError) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><Notice tone="error">{loadError}</Notice></main>;
  if (!loaded) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold">ทีม HR</h1>
      <p className="mt-2 text-sm text-ink-soft">สมาชิกทุกคนจัดการประกาศและผู้สมัครของบริษัทได้ ส่วนข้อมูลบริษัทและสมาชิกเป็นสิทธิ์ของเจ้าของบัญชี (Owner)</p>
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <section aria-labelledby="members-title" className="mt-6">
        <h2 id="members-title" className="text-lg font-bold">สมาชิก ({members.length})</h2>
        <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
          {members.map((member) => {
            const self = member.user_id === user?.id;
            return (
              <li key={member.user_id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
                <Avatar name={member.full_name} size="md" />
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{member.full_name}{self && ' (คุณ)'} <span className="ml-1 rounded-full bg-surface-muted px-2 py-0.5 text-xs font-medium text-ink-soft">{member.member_role === 'OWNER' ? 'Owner' : 'สมาชิก'}</span></p>
                  <p className="truncate text-xs text-ink-soft">{member.email} · เข้าร่วม {dateFormat.format(new Date(member.joined_at))}</p>
                </div>
                {isOwner && member.member_role !== 'OWNER' && (
                  <div className="flex gap-3">
                    <button type="button" disabled={busy} onClick={() => { if (window.confirm(`โอนสิทธิ์ Owner ให้ ${member.full_name}? ผู้รับต้องกดยืนยันก่อนจึงจะมีผล`)) void run(() => request('/companies/me/owner-transfer', { method: 'POST', body: { to_user_id: member.user_id } }), 'ส่งคำขอโอนสิทธิ์แล้ว รอผู้รับยืนยัน'); }}
                      className="font-medium text-primary hover:underline disabled:opacity-60">โอนสิทธิ์ Owner</button>
                    <button type="button" disabled={busy} onClick={() => { if (window.confirm(`ลบ ${member.full_name} ออกจากทีม?`)) void run(() => request(`/companies/me/members/${encodeURIComponent(member.user_id)}`, { method: 'DELETE' }), 'ลบสมาชิกแล้ว'); }}
                      className="font-medium text-danger-text hover:underline disabled:opacity-60">ลบ</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      </section>

      {isOwner && (
        <section aria-labelledby="invite-title" className="mt-8">
          <h2 id="invite-title" className="text-lg font-bold">เชิญสมาชิกใหม่</h2>
          <p className="mt-1 text-sm text-ink-soft">ใช้อีเมลโดเมนขององค์กรเท่านั้น ผู้ได้รับเชิญจะได้ลิงก์ทางอีเมลเพื่อตั้งรหัสผ่านและเข้าร่วมทีม</p>
          <form onSubmit={invite} noValidate className="mt-3 flex flex-col gap-3 sm:flex-row">
            <label className="flex-1 text-sm"><span className="sr-only">อีเมลที่จะเชิญ</span>
              <input type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="name@company.co.th" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
            </label>
            <button type="submit" disabled={busy} className="rounded-lg bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ส่งคำเชิญ</button>
          </form>
        </section>
      )}

      <section aria-labelledby="transfer-title" className="mt-8 rounded-xl border border-border bg-surface-muted p-4">
        <h2 id="transfer-title" className="text-lg font-bold">คำขอโอนสิทธิ์ Owner</h2>
        <p className="mt-1 text-sm text-ink-soft">
          {isOwner ? 'ถ้าส่งคำขอโอนสิทธิ์ไปแล้วและต้องการเปลี่ยนใจ ยกเลิกได้ที่นี่' : 'ถ้าเจ้าของบัญชีส่งคำขอโอนสิทธิ์ Owner มาให้คุณ ตอบรับหรือปฏิเสธได้ที่นี่'}
        </p>
        <div className="mt-3 flex flex-wrap gap-3">
          {isOwner ? (
            <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/owner-transfer/actions/cancel', { method: 'POST' }), 'ยกเลิกคำขอโอนสิทธิ์แล้ว')}
              className="rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-60">ยกเลิกคำขอที่ส่งไว้</button>
          ) : (
            <>
              <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/owner-transfer/actions/accept', { method: 'POST' }), 'รับสิทธิ์ Owner แล้ว กรุณาเข้าสู่ระบบใหม่เพื่อให้สิทธิ์อัปเดต')}
                className="rounded-lg bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ยืนยันรับสิทธิ์ Owner</button>
              <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/owner-transfer/actions/decline', { method: 'POST' }), 'ปฏิเสธคำขอแล้ว')}
                className="rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-60">ปฏิเสธ</button>
            </>
          )}
        </div>
        <p className="mt-2 text-xs text-ink-soft">ไม่มีคำขอที่รออยู่ ระบบจะแจ้งว่าไม่พบคำขอ</p>
      </section>
    </main>
  );
}
