'use client';

import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ConductReportCategory, ConductReportItem, CreateConductReportRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import {
  CONDUCT_CATEGORY_LABEL,
  CONDUCT_DETAIL_MAX,
  CONDUCT_DETAIL_MIN,
  CONDUCT_STATUS_VIEW,
} from '@/components/conduct-reports/conduct-report-meta';
import { formatDateTime } from '@/components/student/application-ui';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

function failure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.issues.includes('NOT_IN_PROGRESS')) return 'รายงานได้เฉพาะนักศึกษาที่กำลังฝึกงานอยู่';
    if (cause.issues.includes('ADVISOR_NOT_LINKED')) return 'นักศึกษายังไม่มีอาจารย์ที่ปรึกษาในระบบ';
    return cause.message;
  }
  return 'ส่งรายงานไม่สำเร็จ กรุณาลองใหม่';
}

/**
 * HR รายงานพฤติกรรมนักศึกษาถึงอาจารย์ที่ปรึกษา (`/hr/applications/{id}/conduct-reports`)
 * ส่งได้เฉพาะตอนกำลังฝึกงาน • ไม่เปลี่ยนสถานะการฝึกงาน • HR เห็นว่าอาจารย์รับทราบแล้วหรือยัง พร้อมหมายเหตุ
 * ซ่อนทั้งส่วนเมื่อไม่ได้กำลังฝึกและไม่เคยมีรายงาน
 */
export function HrConductReports({ applicationId, inProgress }: { applicationId: string; inProgress: boolean }) {
  const { request } = useAuth();
  const fieldId = useId();
  const [reports, setReports] = useState<ConductReportItem[] | null>(null);
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<'' | ConductReportCategory>('');
  const [detail, setDetail] = useState('');
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setReports((await request<{ data: ConductReportItem[] }>(`/hr/applications/${encodeURIComponent(applicationId)}/conduct-reports`)).data);
    } catch {
      setReports([]);
    }
  }, [request, applicationId]);

  useEffect(() => { void load(); }, [load]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = detail.trim();
    if (!category) { setMessage({ tone: 'error', text: 'กรุณาเลือกหมวด' }); return; }
    if (value.length < CONDUCT_DETAIL_MIN) { setMessage({ tone: 'error', text: `กรุณาเล่ารายละเอียดอย่างน้อย ${CONDUCT_DETAIL_MIN} ตัวอักษร` }); return; }
    if (!window.confirm('ส่งรายงานนี้ถึงอาจารย์ที่ปรึกษาของนักศึกษา? ส่งแล้วแก้ไขไม่ได้')) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: CreateConductReportRequest = { category, detail: value };
      await request<ConductReportItem>(`/hr/applications/${encodeURIComponent(applicationId)}/conduct-reports`, { method: 'POST', body });
      setOpen(false);
      setCategory('');
      setDetail('');
      setMessage({ tone: 'success', text: 'ส่งรายงานถึงอาจารย์ที่ปรึกษาแล้ว' });
      await load();
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
    } finally {
      setBusy(false);
    }
  }

  if (!reports || (!inProgress && reports.length === 0)) return null;

  return (
    <section aria-labelledby={`${fieldId}-title`} className="mt-8">
      <h2 id={`${fieldId}-title`} className="text-lg font-semibold">รายงานพฤติกรรมถึงอาจารย์</h2>
      <p className="mt-1 text-sm text-ink-soft">แจ้งอาจารย์ที่ปรึกษาเมื่อนักศึกษามีปัญหาด้านการมาทำงาน ความประพฤติ หรือผลงาน การรายงานไม่เปลี่ยนสถานะการฝึกงาน</p>
      {message && <div className="mt-3"><Notice tone={message.tone}>{message.text}</Notice></div>}

      {inProgress && (open ? (
        <form onSubmit={(event) => void submit(event)} noValidate className="mt-4 space-y-3 rounded-xl border border-border p-4 text-sm">
          <label className="block font-medium">
            หมวด
            <select value={category} onChange={(event) => setCategory(event.target.value as '' | ConductReportCategory)} className={inputClass}>
              <option value="">เลือกหมวด</option>
              {(Object.keys(CONDUCT_CATEGORY_LABEL) as ConductReportCategory[]).map((key) => (
                <option key={key} value={key}>{CONDUCT_CATEGORY_LABEL[key]}</option>
              ))}
            </select>
          </label>
          <label className="block font-medium">
            รายละเอียด
            <textarea value={detail} maxLength={CONDUCT_DETAIL_MAX} rows={4} onChange={(event) => setDetail(event.target.value)}
              placeholder="เล่าสิ่งที่เกิดขึ้น วันที่ และสิ่งที่บริษัทได้แจ้งนักศึกษาแล้ว" className={inputClass} />
            <span className="mt-1 block text-xs font-normal text-ink-soft">{detail.trim().length}/{CONDUCT_DETAIL_MAX}</span>
          </label>
          <div className="flex gap-3">
            <button type="submit" disabled={busy} className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
              {busy ? 'กำลังส่ง…' : 'ส่งถึงอาจารย์'}
            </button>
            <button type="button" onClick={() => setOpen(false)} className="rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted">ยกเลิก</button>
          </div>
        </form>
      ) : (
        <button type="button" onClick={() => { setOpen(true); setMessage(null); }}
          className="mt-4 rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted">
          รายงานพฤติกรรม
        </button>
      ))}

      {reports.length > 0 && (
        <ul className="mt-4 space-y-3">
          {reports.map((report) => {
            const view = CONDUCT_STATUS_VIEW[report.status];
            return (
              <li key={report.id} className="rounded-xl bg-surface-muted p-4 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="font-medium">{CONDUCT_CATEGORY_LABEL[report.category]}</span>
                  <StatusBadge tone={view.tone}>{view.label}</StatusBadge>
                </div>
                <p className="mt-1 text-xs text-ink-soft">ส่งเมื่อ {formatDateTime(report.created_at)}</p>
                <p className="mt-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{report.detail}</p>
                {report.advisor_note && <p className="mt-2 text-ink-soft">หมายเหตุจากอาจารย์: <span className="text-ink">{report.advisor_note}</span></p>}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
