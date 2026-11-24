'use client';

import Link from 'next/link';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Paginated, ProblemReportItem, ProblemReportStatus, ResolveProblemReportRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { type Message, NOTE_MAX, PAGE_SIZE, Pager, failure, inputClass, primaryButton, secondaryButton } from '@/components/advisor/advisor-ui';
import {
  PROBLEM_CATEGORY_LABEL as CATEGORY_LABEL,
  PROBLEM_FOLLOW_UP_LABEL as FOLLOW_UP_LABEL,
  PROBLEM_STATUS_VIEW as STATUS_VIEW,
  type ProblemFollowUp as FollowUp,
} from '@/components/problem-reports/problem-report-meta';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDateTime } from '@/components/student/application-ui';

/**
 * รายงานปัญหาระหว่างฝึกงานของนักศึกษาในความดูแล (README §5.2.2, UAT-39) — บริษัทมองไม่เห็นรายงาน
 * - รายการ `GET /advisor/problem-reports?status=`
 * - `OPEN` → `POST /problem-reports/{id}/actions/acknowledge` → `ACKNOWLEDGED` → `.../resolve` `{note, follow_up_action?}`
 * การรายงานและการปิดเรื่องไม่เปลี่ยนสถานะใบสมัคร — ถ้าต้องยุติการฝึกจริง ให้ยุติจากใบสมัครแยกต่างหาก
 */
export function AdvisorProblemReports() {
  const { request } = useAuth();
  const [status, setStatus] = useState<'' | ProblemReportStatus>('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<ProblemReportItem> | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState<'' | FollowUp>('');

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      if (status) query.set('status', status);
      setList(await request<Paginated<ProblemReportItem>>(`/advisor/problem-reports?${query.toString()}`));
    } catch (cause) {
      setList(null);
      setMessage({ tone: 'error', text: failure(cause) });
    }
  }, [request, status, page]);

  useEffect(() => { void load(); }, [load]);

  async function act(report: ProblemReportItem, action: 'acknowledge' | 'resolve', body?: ResolveProblemReportRequest) {
    setBusyId(report.id);
    setMessage(null);
    try {
      await request(`/problem-reports/${encodeURIComponent(report.id)}/actions/${action}`, { method: 'POST', body });
      setResolving(null);
      setMessage({ tone: 'success', text: action === 'acknowledge' ? 'รับเรื่องแล้ว' : 'ปิดเรื่องแล้ว' });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
    } finally {
      setBusyId(null);
      await load();
    }
  }

  function submitResolve(event: FormEvent, report: ProblemReportItem) {
    event.preventDefault();
    const value = note.trim();
    if (!value) { setMessage({ tone: 'error', text: 'กรุณาสรุปผลการดำเนินการก่อนปิดเรื่อง' }); return; }
    if (value.length > NOTE_MAX) { setMessage({ tone: 'error', text: `ข้อความต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }
    void act(report, 'resolve', { note: value, ...(followUp ? { follow_up_action: followUp } : {}) });
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">รายงานปัญหาระหว่างฝึกงาน</h1>
      <p className="mt-2 text-sm text-ink-soft">
        รายงานจากนักศึกษาในความดูแล ส่งถึงอาจารย์และผู้ดูแลระบบพร้อมกัน บริษัทมองไม่เห็นรายงานเหล่านี้
      </p>

      <div className="mt-6 flex flex-wrap gap-2" role="group" aria-label="สถานะรายงาน">
        {([['', 'ทั้งหมด'], ['OPEN', 'เปิดอยู่'], ['ACKNOWLEDGED', 'รับทราบแล้ว'], ['RESOLVED', 'แก้ไขแล้ว']] as const).map(([value, label]) => (
          <button key={value} type="button" aria-pressed={status === value}
            className={`rounded-full border px-4 py-2 text-sm font-medium ${status === value ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}
            onClick={() => { setStatus(value); setPage(1); setResolving(null); }}>{label}</button>
        ))}
      </div>

      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {list && list.data.length === 0 && <p className="mt-6 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">ไม่มีรายงานในสถานะนี้</p>}

      <ul className="mt-6 space-y-4">
        {list?.data.map((report) => {
          const view = STATUS_VIEW[report.status];
          return (
            <li key={report.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{CATEGORY_LABEL[report.category]}</p>
                  <p className="text-xs text-ink-soft">รายงานเมื่อ {formatDateTime(report.created_at)} · กำหนดดำเนินการ {formatDateTime(report.due_at)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {report.overdue && <StatusBadge tone="danger">OVERDUE</StatusBadge>}
                  <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>
                </div>
              </div>
              <p className="mt-3 whitespace-pre-line text-sm">{report.detail}</p>
              {report.resolution_note && (
                <p className="mt-3 rounded-xl bg-surface-muted p-3 text-sm">
                  ผลการดำเนินการ: {report.resolution_note}
                  {report.follow_up_action && <span className="text-ink-soft"> ({FOLLOW_UP_LABEL[report.follow_up_action]})</span>}
                </p>
              )}
              <div className="mt-4 flex flex-wrap items-center gap-3">
                {report.status === 'OPEN' && (
                  <button type="button" disabled={busyId === report.id} onClick={() => void act(report, 'acknowledge')} className={primaryButton}>รับเรื่อง</button>
                )}
                {report.status !== 'RESOLVED' && resolving !== report.id && (
                  <button type="button" disabled={busyId === report.id} onClick={() => { setResolving(report.id); setNote(''); setFollowUp(''); setMessage(null); }}
                    className={secondaryButton}>ปิดเรื่อง</button>
                )}
                <Link href={`/advisor/students/item?id=${report.student_user_id}`} className="text-sm font-medium text-primary hover:underline">ดูข้อมูลนักศึกษา ›</Link>
              </div>
              {resolving === report.id && (
                <form onSubmit={(event) => submitResolve(event, report)} noValidate className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 text-sm">
                  <label className="block font-medium">
                    สรุปผลการดำเนินการ
                    <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={3} className={inputClass} />
                  </label>
                  <label className="block font-medium">
                    ดำเนินการต่อ (ไม่บังคับ)
                    <select value={followUp} onChange={(event) => setFollowUp(event.target.value as '' | FollowUp)} className={inputClass}>
                      <option value="">ไม่มี</option>
                      {(Object.keys(FOLLOW_UP_LABEL) as FollowUp[]).map((value) => <option key={value} value={value}>{FOLLOW_UP_LABEL[value]}</option>)}
                    </select>
                  </label>
                  {followUp === 'TERMINATE' && <p className="text-xs text-warning-text">การปิดเรื่องไม่ยุติการฝึกให้อัตโนมัติ ต้องยุติจากใบสมัครแยกต่างหาก</p>}
                  <div className="flex gap-3">
                    <button type="submit" disabled={busyId === report.id} className={primaryButton}>{busyId === report.id ? 'กำลังบันทึก…' : 'ยืนยันปิดเรื่อง'}</button>
                    <button type="button" onClick={() => setResolving(null)} className={secondaryButton}>ยกเลิก</button>
                  </div>
                </form>
              )}
            </li>
          );
        })}
      </ul>

      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </main>
  );
}
