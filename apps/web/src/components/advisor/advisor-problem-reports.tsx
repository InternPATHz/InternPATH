'use client';

import Link from 'next/link';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Paginated, ProblemReportItem, ProblemReportStatus, ResolveProblemReportRequest } from '@internpath/contracts';
import type { AdvisorStudentOverview } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { type Message, NOTE_MAX, PAGE_SIZE, Pager, failure, inputClass, primaryButton, secondaryButton } from '@/components/advisor/advisor-ui';
import {
  PROBLEM_CATEGORY_LABEL as CATEGORY_LABEL,
  PROBLEM_FOLLOW_UP_LABEL as FOLLOW_UP_LABEL,
  PROBLEM_STATUS_VIEW as STATUS_VIEW,
  type ProblemFollowUp as FollowUp,
} from '@/components/problem-reports/problem-report-meta';
import { ApiError } from '@/lib/api';
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
  const [selectedId, setSelectedId] = useState('');
  const [status, setStatus] = useState<'' | ProblemReportStatus>('OPEN');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<ProblemReportItem> | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [followUp, setFollowUp] = useState<'' | FollowUp>('');

  const [revision, setRevision] = useState(0);
  const currentView = useRef(0);
  useEffect(() => {
    let active = true;
    setList(null);
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (status) query.set('status', status);
    request<Paginated<ProblemReportItem>>(`/advisor/problem-reports?${query}`).then(
      (rows) => { if (active) setList(rows); },
      (cause) => { if (active) setMessage({ tone: 'error', text: failure(cause) }); },
    );
    return () => { active = false; currentView.current++; };
  }, [request, status, page, revision]);

  // A concurrent resolution may have moved the case to another page of the closed queue.
  async function showResolution(reportId: string, view: number) {
    for (let next = 1; currentView.current === view; next++) {
      const rows = await request<Paginated<ProblemReportItem>>(`/advisor/problem-reports?status=RESOLVED&page=${next}&page_size=${PAGE_SIZE}`);
      if (currentView.current !== view) return;
      if (rows.data.some((row) => row.id === reportId)) {
        setStatus('RESOLVED'); setPage(next); setSelectedId(reportId);
        break;
      }
      if (!rows.data.length || next * rows.meta.page_size >= rows.meta.total) break;
    }
  }

  async function act(report: ProblemReportItem, action: 'acknowledge' | 'resolve', body?: ResolveProblemReportRequest) {
    const view = currentView.current;
    setBusyId(report.id);
    setMessage(null);
    try {
      await request(`/problem-reports/${encodeURIComponent(report.id)}/actions/${action}`, { method: 'POST', body });
      if (currentView.current !== view) return;
      setRevision((n) => n + 1);
      setResolving(null);
      setMessage({ tone: 'success', text: action === 'acknowledge' ? 'รับเรื่องแล้ว' : 'ปิดเรื่องแล้ว' });
    } catch (cause) {
      if (currentView.current !== view) return;
      setMessage({ tone: 'error', text: failure(cause) });
      if (cause instanceof ApiError && cause.status === 409) {
        setResolving(null);
        if (cause.issues.includes('ALREADY_RESOLVED')) {
          try { await showResolution(report.id, view); }
          catch (error) { if (currentView.current === view) setMessage({ tone: 'error', text: failure(error) }); }
        }
        if (currentView.current === view) setRevision((n) => n + 1);
      }
    } finally {
      setBusyId(null);
    }
  }

  function submitResolve(event: FormEvent, report: ProblemReportItem) {
    event.preventDefault();
    const value = note.trim();
    if (!value) { setMessage({ tone: 'error', text: 'กรุณาสรุปผลการดำเนินการก่อนปิดเรื่อง' }); return; }
    if (value.length > NOTE_MAX) { setMessage({ tone: 'error', text: `ข้อความต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }
    void act(report, 'resolve', { note: value, ...(followUp ? { follow_up_action: followUp } : {}) });
  }

  const selected = list?.data.find((item) => item.id === selectedId) ?? list?.data[0];

  const [context, setContext] = useState<AdvisorStudentOverview | null>(null);
  const studentId = selected?.student_user_id;
  useEffect(() => {
    let active = true;
    setContext(null);
    if (studentId) request<AdvisorStudentOverview>(`/advisor/students/${encodeURIComponent(studentId)}/overview`).then(
      (data) => { if (active) setContext(data); }, () => {},
    );
    return () => { active = false; };
  }, [request, studentId]);
  const internship = context?.applications.find((app) => app.id === selected?.application_id);
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

      <div className="mt-5 grid items-start gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
        <ul aria-label="เลือกรายงาน" className="hidden min-w-0 divide-y divide-border lg:block">
          {list?.data.map((report) => <li key={report.id}><button aria-pressed={report.id === selected?.id} className="w-full rounded-lg p-3 text-left text-sm aria-pressed:bg-primary-soft" onClick={() => { setSelectedId(report.id); setResolving(null); }}>
            <strong className="block">{CATEGORY_LABEL[report.category]}</strong>{STATUS_VIEW[report.status].label} · {formatDateTime(report.due_at)} {report.overdue && '· เกินกำหนด'}
          </button></li>)}</ul>
        <ul className="min-w-0 space-y-4 [overflow-wrap:anywhere]">
        {list?.data.map((report) => {
          const view = STATUS_VIEW[report.status];
          return (
            <li key={report.id} className={`rounded-xl border border-border bg-surface p-5 ${selected?.id === report.id ? '' : 'lg:hidden'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="font-semibold">{CATEGORY_LABEL[report.category]}</p>
                  <p className="text-xs text-ink-soft">รายงานเมื่อ {formatDateTime(report.created_at)} · กำหนดดำเนินการ {formatDateTime(report.due_at)}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  {report.overdue && <StatusBadge tone="danger">เกินกำหนด</StatusBadge>}
                  <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>
                </div>
              </div>
              {selected?.id === report.id && context?.student_user_id === report.student_user_id && <p className="mt-3 text-sm font-semibold">{context.full_name}{internship && ` · ${internship.job_title} · ${internship.company_name}`}</p>}
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
              {report.status !== 'RESOLVED' && resolving === report.id && (
                <form onSubmit={(event) => submitResolve(event, report)} noValidate className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 text-sm">
                  <label className="block font-medium">
                    สรุปผลการดำเนินการ
                    <textarea maxLength={NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} rows={3} className={inputClass} />
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
      </ul></div>

      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </main>
  );
}
