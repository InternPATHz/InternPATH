'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AdvisorListItem, UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';
import { asList } from '@/lib/list';
import { CircleCheck, CircleDashed, CircleX } from 'lucide-react';

const failure = (cause: unknown) => (cause instanceof ApiError ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');

/**
 * ผูกอาจารย์ที่ปรึกษา (api-contract §4.2): ต้องผูกก่อนจึงสมัครงานได้ (`ADVISOR_NOT_LINKED`)
 * สถานะ NONE → ADVISOR_LINK_PENDING (รออาจารย์ยืนยัน) → LINKED; ขอเปลี่ยนอาจารย์ได้ระหว่าง LINKED (ยังเป็นคนเดิมจนกว่าอาจารย์ใหม่ยืนยัน)
 */
export function AdvisorLink() {
  const { request } = useAuth();
  const [me, setMe] = useState<UserMeResponse | null>(null);
  const [advisors, setAdvisors] = useState<AdvisorListItem[]>([]);
  const [q, setQ] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);

  const loadMe = useCallback(async () => {
    try { setMe(await request<UserMeResponse>('/users/me')); setLoadError(null); }
    catch (cause) { setLoadError(failure(cause)); }
  }, [request]);

  const search = useCallback(async (query: string) => {
    try {
      const result = await request<AdvisorListItem[] | { data: AdvisorListItem[] }>(`/advisors${query ? `?q=${encodeURIComponent(query)}` : ''}`);
      setAdvisors(asList(result as never));
    } catch (cause) { setMessage({ tone: 'error', text: failure(cause) }); }
  }, [request]);

  useEffect(() => { void loadMe(); void search(''); }, [loadMe, search]);

  async function run(action: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try { await action(); await loadMe(); setChanging(false); setMessage({ tone: 'success', text: success }); }
    catch (cause) { setMessage({ tone: 'error', text: failure(cause) }); }
    finally { setBusy(false); }
  }

  if (loadError) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><Notice tone="error">{loadError}</Notice></main>;
  if (!me?.student) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const { advisor_link_status: status, advisor_id: currentId, pending_advisor_id: pendingId } = me.student;
  const nameOf = (advisorId?: string) => advisors.find((advisor) => advisor.id === advisorId);
  const showPicker = status === 'NONE' || changing;
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-bold">อาจารย์ที่ปรึกษา</h1>
      <p className="mt-2 text-sm text-ink-soft">ต้องผูกอาจารย์ที่ปรึกษาและรอให้อาจารย์ยืนยันก่อน จึงจะสมัครงานได้</p>

      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <section aria-labelledby="link-title" className="mt-6 rounded-xl border border-border bg-surface-muted p-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="link-title" className="text-lg font-bold">สถานะการผูก</h2>
          {status === 'LINKED' && <StatusBadge tone="success" icon={CircleCheck}>ผูกแล้ว</StatusBadge>}
          {status === 'ADVISOR_LINK_PENDING' && <StatusBadge tone="warning" icon={CircleDashed}>รออาจารย์ยืนยัน</StatusBadge>}
          {status === 'NONE' && <StatusBadge tone="neutral" icon={CircleX}>ยังไม่ได้ผูก</StatusBadge>}
        </div>
        {status === 'LINKED' && <p className="mt-2 text-sm">อาจารย์ที่ปรึกษาของคุณ: <span className="font-medium">{nameOf(currentId)?.full_name ?? 'อาจารย์ที่ผูกไว้'}</span>{nameOf(currentId)?.department && ` (${nameOf(currentId)?.department})`}</p>}
        {status === 'ADVISOR_LINK_PENDING' && (
          <>
            <p className="mt-2 text-sm">ส่งคำขอถึง <span className="font-medium">{nameOf(pendingId)?.full_name ?? 'อาจารย์ที่เลือก'}</span> แล้ว รออาจารย์ยืนยัน{currentId && ' (ระหว่างนี้ยังใช้อาจารย์คนเดิมอยู่)'}</p>
            <button type="button" disabled={busy} onClick={() => void run(() => request('/users/me/advisor-link', { method: 'DELETE' }), 'ยกเลิกคำขอแล้ว')}
              className="mt-3 rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface disabled:opacity-60">ยกเลิกคำขอ</button>
          </>
        )}
        {status === 'LINKED' && !changing && (
          <button type="button" onClick={() => { setChanging(true); setMessage(null); }} className="mt-3 rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface">ขอเปลี่ยนอาจารย์</button>
        )}
      </section>

      {showPicker && (
        <section aria-labelledby="pick-title" className="mt-8">
          <h2 id="pick-title" className="text-lg font-bold">{status === 'NONE' ? 'เลือกอาจารย์ที่ปรึกษา' : 'เลือกอาจารย์คนใหม่'}</h2>
          <p className="mt-1 text-sm text-ink-soft">แสดงอาจารย์ในมหาวิทยาลัยเดียวกับคุณที่ผ่านการอนุมัติแล้ว</p>
          <form role="search" onSubmit={(event: FormEvent) => { event.preventDefault(); void search(q.trim()); }} className="mt-3 flex gap-3">
            <label className="flex-1 text-sm"><span className="sr-only">ค้นหาอาจารย์</span>
              <input type="search" value={q} onChange={(event) => setQ(event.target.value)} placeholder="ค้นหาชื่ออาจารย์" className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary" />
            </label>
            <button type="submit" className="rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted">ค้นหา</button>
          </form>
          {advisors.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-soft">ไม่พบอาจารย์ที่ตรงกับเงื่อนไข</p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
              {advisors.filter((advisor) => advisor.id !== currentId).map((advisor) => (
                <li key={advisor.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                  <div><p className="font-medium">{advisor.full_name}</p>{advisor.department && <p className="text-xs text-ink-soft">{advisor.department}</p>}</div>
                  <button type="button" disabled={busy} onClick={() => void run(() => request('/users/me/advisor-link', { method: 'POST', body: { advisor_id: advisor.id } }), 'ส่งคำขอแล้ว รออาจารย์ยืนยัน')}
                    className="rounded-lg bg-primary px-4 py-2 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ขอผูกกับอาจารย์ท่านนี้</button>
                </li>
              ))}
            </ul>
          )}
          {changing && <button type="button" onClick={() => setChanging(false)} className="mt-3 text-sm font-medium text-primary hover:underline">ยกเลิก</button>}
        </section>
      )}
    </main>
  );
}
