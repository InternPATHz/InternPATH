'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { AdvisorApplicationItem, ApplicationStatus, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import {
  ApplicationSummary, type Message, PAGE_SIZE, Pager, REASON_MAX, ResumeButton, failure, inputClass, primaryButton, secondaryButton,
} from '@/components/advisor/advisor-ui';

const STATUS_OPTIONS: Array<[ApplicationStatus, string]> = [
  ['ADVISOR_PENDING', 'รออนุมัติ'],
  ['ADVISOR_APPROVED', 'อนุมัติแล้ว รอเริ่มงาน'],
  ['IN_PROGRESS', 'กำลังฝึกงาน'],
  ['ADVISOR_REJECTED', 'ไม่อนุมัติ'],
];

/**
 * หน้าอาจารย์อนุมัติคำขอออกฝึกงาน (README §8 Advisor Approval Dashboard, UAT-15/16)
 * - รายการ `GET /advisor/applications?status=` (ค่าเริ่มต้น `ADVISOR_PENDING`)
 * - อนุมัติ `POST /advisor/applications/{id}/actions/approve`
 * - ไม่อนุมัติ `POST .../actions/reject` — **บังคับเหตุผล** (เซิร์ฟเวอร์ตอบ `400 REASON_REQUIRED` ถ้าว่าง)
 * สถานะจริงมาจากเซิร์ฟเวอร์เสมอ: ทำรายการเสร็จหรือชนกัน (409) ⇒ โหลดรายการใหม่
 */
export function AdvisorApprovals() {
  const { request } = useAuth();
  const [status, setStatus] = useState<ApplicationStatus>('ADVISOR_PENDING');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<AdvisorApplicationItem> | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<Message | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const approvalDialog = useRef<HTMLDialogElement>(null);
  const [approving, setApproving] = useState<AdvisorApplicationItem | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const query = new URLSearchParams({ status, page: String(page), page_size: String(PAGE_SIZE) });
      setList(await request<Paginated<AdvisorApplicationItem>>(`/advisor/applications?${query.toString()}`));
    } catch (cause) {
      setList(null);
      setMessage({ tone: 'error', text: failure(cause) });
    } finally { setLoading(false); }
  }, [request, status, page]);

  useEffect(() => { void load(); }, [load]);

  async function act(app: AdvisorApplicationItem, action: 'approve' | 'reject', body?: { reason: string }) {
    setBusyId(app.id);
    setMessage(null);
    try {
      await request(`/advisor/applications/${encodeURIComponent(app.id)}/actions/${action}`, { method: 'POST', body });
      setRejecting(null);
      setReason('');
      setMessage({
        tone: 'success',
        text: action === 'approve'
          ? `อนุมัติให้ ${app.student_name} ออกฝึกงานที่ ${app.company_name} แล้ว รอ HR ยืนยันวันเริ่มงาน`
          : `ไม่อนุมัติคำขอของ ${app.student_name} แล้ว ระบบแจ้งนักศึกษาและคืนโควตาให้บริษัท`,
      });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
    } finally {
      setBusyId(null);
      await load();
    }
  }

  function approve(app: AdvisorApplicationItem) {
    setApproving(app);
    approvalDialog.current?.showModal();
  }

  function submitReject(event: FormEvent, app: AdvisorApplicationItem) {
    event.preventDefault();
    const value = reason.trim();
    if (!value) { setMessage({ tone: 'error', text: 'การไม่อนุมัติต้องระบุเหตุผล' }); return; }
    if (value.length > REASON_MAX) { setMessage({ tone: 'error', text: `เหตุผลต้องไม่เกิน ${REASON_MAX} ตัวอักษร` }); return; }
    void act(app, 'reject', { reason: value });
  }

  const selected = list?.data.find((app) => app.id === selectedId) ?? list?.data[0];
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">อนุมัติการออกฝึกงาน</h1>
      <p className="mt-2 text-sm text-ink-soft">
        ตรวจคำขอออกฝึกงานของนักศึกษาในความดูแล และความตรงสายก่อนเริ่มฝึก การไม่อนุมัติต้องระบุเหตุผลเสมอ
      </p>

      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-xl bg-surface-muted p-4">
        <FilterSelect label="สถานะ" value={status} onChange={(value) => { setStatus(value as ApplicationStatus); setPage(1); setRejecting(null); }}
          options={STATUS_OPTIONS} />
      </div>

      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      {loading && !list && <p className="mt-6 text-sm text-ink-soft">กำลังโหลด…</p>}
      {list && list.data.length === 0 && (
        <p className="mt-6 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">
          {status === 'ADVISOR_PENDING' ? 'ไม่มีคำขอที่รออนุมัติ' : 'ไม่มีรายการในสถานะนี้'}
        </p>
      )}

      <div className="mt-6 grid gap-4 lg:grid-cols-[minmax(16rem,1fr)_minmax(0,2fr)]">
        {!!list?.data.length && (
          <ul className="hidden min-w-0 divide-y divide-border self-start [overflow-wrap:anywhere] rounded-xl border border-border lg:block" aria-label="เลือกใบสมัคร">
            {list.data.map((app) => (
              <li key={app.id}>
                <button type="button" aria-pressed={selected?.id === app.id} onClick={() => { setSelectedId(app.id); setRejecting(null); }}
                  className={`w-full p-4 text-left ${selected?.id === app.id ? 'bg-primary-soft' : 'hover:bg-surface-muted'}`}>
                  <span className="block font-semibold">{app.student_name}</span>
                  <span className="block text-sm text-ink-soft">{app.company_name}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <ul className="min-w-0 space-y-4">
          {list?.data.map((app) => (
            <li key={app.id} className={`rounded-xl border border-border bg-surface p-5 ${selected?.id === app.id ? '' : 'lg:hidden'}`}>
              <ApplicationSummary app={app} />
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <ResumeButton applicationId={app.id} onError={(text) => setMessage({ tone: 'error', text })} />
                {app.status === 'ADVISOR_PENDING' && (
                  <>
                    <span className="flex-1" />
                    <button type="button" disabled={busyId === app.id} onClick={() => approve(app)} className={primaryButton}>อนุมัติ</button>
                    <button type="button" disabled={busyId === app.id} onClick={() => { setRejecting(app.id); setReason(''); setMessage(null); }}
                      className={`${secondaryButton} text-danger-text`}>ไม่อนุมัติ</button>
                  </>
                )}
              </div>
              {rejecting === app.id && (
                <form onSubmit={(event) => submitReject(event, app)} noValidate className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 text-sm">
                  <label className="block font-medium">
                    เหตุผลที่ไม่อนุมัติ (นักศึกษาจะเห็นเหตุผลนี้)
                    <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} className={inputClass} />
                    <span className="mt-1 block text-xs font-normal text-ink-soft">{reason.length}/{REASON_MAX}</span>
                  </label>
                  <div className="flex gap-3">
                    <button type="submit" disabled={busyId === app.id} className={primaryButton}>{busyId === app.id ? 'กำลังส่ง…' : 'ยืนยันไม่อนุมัติ'}</button>
                    <button type="button" onClick={() => setRejecting(null)} className={secondaryButton}>ยกเลิก</button>
                  </div>
                </form>
              )}
            </li>
          ))}
        </ul>

      </div>
      <dialog ref={approvalDialog} onClose={() => setApproving(null)} aria-labelledby="approve-title"
        className="m-auto w-[calc(100%-2rem)] max-w-md [overflow-wrap:anywhere] rounded-xl bg-surface p-6 text-ink backdrop:bg-black/40">
        <h2 id="approve-title" className="text-xl font-semibold">อนุมัติการออกฝึกงาน</h2>
        {approving && <>
          <p className="mt-2 text-sm">อนุมัติให้ {approving.student_name} ออกฝึกงานที่ {approving.company_name}</p>
          {approving.major_mismatch && <p className="mt-2 rounded-lg bg-warning-soft p-3 text-sm text-warning-text">สาขาของนักศึกษาไม่ตรงกับที่ประกาศระบุ</p>}
          <p className="mt-2 text-sm text-ink-soft">ระบบจะถอนใบสมัครอื่นของนักศึกษาที่ยังรอบริษัทพิจารณา</p>
        </>}
        <form method="dialog" className="mt-5 flex flex-wrap justify-end gap-2">
          <button type="submit" className={secondaryButton}>ยกเลิก</button>
          <button type="button" className={primaryButton} disabled={!approving || busyId !== null} onClick={() => {
            if (!approving) return;
            approvalDialog.current?.close();
            void act(approving, 'approve');
          }}>ยืนยันอนุมัติ</button>
        </form>
      </dialog>
      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </main>
  );
}
