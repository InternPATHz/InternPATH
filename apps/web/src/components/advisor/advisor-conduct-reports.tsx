'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { AcknowledgeConductReportRequest, ConductReportItem, ConductReportStatus, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { type Message, PAGE_SIZE, Pager, failure, inputClass, primaryButton, secondaryButton } from '@/components/advisor/advisor-ui';
import { CONDUCT_CATEGORY_LABEL, CONDUCT_DETAIL_MAX, CONDUCT_STATUS_VIEW } from '@/components/conduct-reports/conduct-report-meta';
import { formatDateTime } from '@/components/student/application-ui';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';

/**
 * รายงานพฤติกรรมนักศึกษาที่บริษัทส่งถึงอาจารย์ — `GET /advisor/conduct-reports?status=`
 * อาจารย์กด "รับทราบ" (ใส่หมายเหตุถึงบริษัทได้) → `POST /advisor/conduct-reports/{id}/actions/acknowledge`
 * การรายงานไม่เปลี่ยนสถานะใบสมัคร — ถ้าต้องยุติการฝึก ให้ทำจากหน้านักศึกษา
 */
export function AdvisorConductReports() {
  const { request } = useAuth();
  const [status, setStatus] = useState<'' | ConductReportStatus>('OPEN');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<ConductReportItem> | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [revision, setRevision] = useState(0);
  const [acknowledging, setAcknowledging] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    setList(null);
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (status) query.set('status', status);
    request<Paginated<ConductReportItem>>(`/advisor/conduct-reports?${query}`).then(
      (rows) => { if (active) setList(rows); },
      (cause) => { if (active) setMessage({ tone: 'error', text: failure(cause) }); },
    );
    return () => { active = false; };
  }, [request, status, page, revision]);

  async function acknowledge(event: FormEvent, report: ConductReportItem) {
    event.preventDefault();
    const value = note.trim();
    setBusy(true);
    setMessage(null);
    try {
      const body: AcknowledgeConductReportRequest = value ? { note: value } : {};
      await request<ConductReportItem>(`/advisor/conduct-reports/${encodeURIComponent(report.id)}/actions/acknowledge`, { method: 'POST', body });
      setAcknowledging(null);
      setNote('');
      setMessage({ tone: 'success', text: `รับทราบรายงานของ ${report.student_name || 'นักศึกษา'} แล้ว บริษัทจะเห็นสถานะนี้` });
    } catch (cause) {
      const already = cause instanceof ApiError && cause.issues.includes('ALREADY_ACKNOWLEDGED');
      setMessage({ tone: 'error', text: already ? 'รายงานนี้ถูกรับทราบไปแล้ว' : failure(cause) });
    } finally {
      setBusy(false);
      setRevision((value) => value + 1);
    }
  }

  return (
    <main className="mx-auto max-w-5xl px-4 py-8 sm:px-6">
      <h1 className="text-2xl font-semibold">รายงานพฤติกรรมจากบริษัท</h1>
      <p className="mt-1 text-sm text-ink-soft">
        บริษัทรายงานพฤติกรรมของนักศึกษาในความดูแลที่กำลังฝึกงาน กด &quot;รับทราบ&quot; เพื่อแจ้งบริษัทว่าอาจารย์เห็นแล้ว (เขียนหมายเหตุถึงบริษัทได้)
        การรายงานไม่เปลี่ยนสถานะการฝึกงาน
      </p>
      <div className="mt-4 flex flex-wrap items-end gap-3 rounded-xl bg-surface-muted p-4">
        <FilterSelect label="สถานะ" value={status} onChange={(value) => { setStatus(value as '' | ConductReportStatus); setPage(1); }}
          options={[['OPEN', 'รอรับทราบ'], ['ACKNOWLEDGED', 'รับทราบแล้ว'], ['', 'ทั้งหมด']]} />
      </div>
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {!list && !message && <p className="mt-6 text-sm text-ink-soft">กำลังโหลด…</p>}
      {list && list.data.length === 0 && (
        <p className="mt-6 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">
          {status === 'OPEN' ? 'ไม่มีรายงานที่รอรับทราบ' : 'ยังไม่มีรายงานจากบริษัท'}
        </p>
      )}
      <ul className="mt-4 space-y-4">
        {list?.data.map((report) => {
          const view = CONDUCT_STATUS_VIEW[report.status];
          return (
            <li key={report.id} className="rounded-xl border border-border bg-surface p-5">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-medium">
                    <Link href={`/advisor/students/item?id=${encodeURIComponent(report.student_user_id)}`} className="text-primary hover:underline">
                      {report.student_name || 'นักศึกษา'}
                    </Link>
                  </p>
                  <p className="text-sm text-ink-soft [overflow-wrap:anywhere]">{report.company_name || 'บริษัท'} · {report.job_title || 'ประกาศงาน'}</p>
                </div>
                <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
              </div>
              <p className="mt-3 text-sm"><span className="text-ink-soft">หมวด</span> {CONDUCT_CATEGORY_LABEL[report.category]} · <span className="text-ink-soft">รายงานเมื่อ</span> {formatDateTime(report.created_at)}</p>
              <p className="mt-2 whitespace-pre-wrap rounded-lg bg-surface-muted p-3 text-sm [overflow-wrap:anywhere]">{report.detail}</p>
              {report.status === 'ACKNOWLEDGED' && (
                <p className="mt-2 text-sm text-ink-soft">
                  รับทราบเมื่อ {report.acknowledged_at ? formatDateTime(report.acknowledged_at) : '-'}
                  {report.advisor_note && <> · หมายเหตุถึงบริษัท: <span className="text-ink">{report.advisor_note}</span></>}
                </p>
              )}
              {report.status === 'OPEN' && (acknowledging === report.id ? (
                <form onSubmit={(event) => void acknowledge(event, report)} className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 text-sm">
                  <label className="block font-medium">
                    หมายเหตุถึงบริษัท (ไม่บังคับ)
                    <textarea maxLength={CONDUCT_DETAIL_MAX} value={note} onChange={(event) => setNote(event.target.value)} rows={2} className={inputClass} />
                  </label>
                  <div className="flex gap-3">
                    <button type="submit" disabled={busy} className={primaryButton}>{busy ? 'กำลังบันทึก…' : 'ยืนยันรับทราบ'}</button>
                    <button type="button" onClick={() => setAcknowledging(null)} className={secondaryButton}>ยกเลิก</button>
                  </div>
                </form>
              ) : (
                <div className="mt-4"><button type="button" onClick={() => { setAcknowledging(report.id); setNote(''); }} className={primaryButton}>รับทราบ</button></div>
              ))}
            </li>
          );
        })}
      </ul>
      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </main>
  );
}
