'use client';

import { CircleCheck, Clock5, ScanSearch } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { Paginated, ProblemReportCategory, ProblemReportItem, ProblemReportStatus, ResolveProblemReportRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { type Message, NOTE_MAX, PAGE_SIZE, Pager, failure, inputClass, primaryButton, secondaryButton } from '@/components/advisor/advisor-ui';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { formatDateTime } from '@/components/student/application-ui';

const CATEGORY_LABEL: Record<ProblemReportCategory, string> = {
  WORKLOAD_OR_HOURS: 'ปริมาณงานหรือชั่วโมงทำงาน',
  NO_ALLOWANCE_AS_PROMISED: 'ไม่ได้รับค่าตอบแทนตามที่ระบุ',
  UNSAFE_OR_HARASSMENT: 'ความไม่ปลอดภัยหรือการคุกคาม',
  DIFFERENT_FROM_JOB_POST: 'งานไม่ตรงกับประกาศ',
  OTHER: 'อื่น ๆ',
};

const STATUS_VIEW: Record<ProblemReportStatus, { label: string; tone: StatusTone; icon: typeof Clock5 }> = {
  OPEN: { label: 'รอรับเรื่อง', tone: 'warning', icon: Clock5 },
  ACKNOWLEDGED: { label: 'รับเรื่องแล้ว', tone: 'info', icon: ScanSearch },
  RESOLVED: { label: 'ปิดเรื่องแล้ว', tone: 'success', icon: CircleCheck },
};

type FollowUp = NonNullable<ResolveProblemReportRequest['follow_up_action']>;
const FOLLOW_UP_LABEL: Record<FollowUp, string> = {
  MONITOR_COMPANY: 'ติดตามบริษัท',
  TERMINATE: 'ยุติการฝึก',
  ESCALATE_COMPANY_REVIEW: 'ส่งต่อให้ตรวจบัญชีบริษัท',
};

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

      <div className="mt-6 flex flex-wrap items-end gap-3 rounded-xl bg-surface-muted p-4">
        <FilterSelect label="สถานะ" value={status} onChange={(value) => { setStatus(value as '' | ProblemReportStatus); setPage(1); setResolving(null); }}
          options={[['', 'ทั้งหมด'], ['OPEN', 'รอรับเรื่อง'], ['ACKNOWLEDGED', 'รับเรื่องแล้ว'], ['RESOLVED', 'ปิดเรื่องแล้ว']]} />
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
              <div className="mt-4 flex flex-wrap gap-3">
                {report.status === 'OPEN' && (
                  <button type="button" disabled={busyId === report.id} onClick={() => void act(report, 'acknowledge')} className={primaryButton}>รับเรื่อง</button>
                )}
                {report.status !== 'RESOLVED' && resolving !== report.id && (
                  <button type="button" disabled={busyId === report.id} onClick={() => { setResolving(report.id); setNote(''); setFollowUp(''); setMessage(null); }}
                    className={secondaryButton}>ปิดเรื่อง</button>
                )}
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
