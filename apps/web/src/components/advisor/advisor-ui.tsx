'use client';

import { AlertTriangle, FileText } from 'lucide-react';
import { useState } from 'react';
import type { AdvisorApplicationItem, ResumeUrlResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApplicationStatusBadge, formatDate } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';

export const PAGE_SIZE = 20;
/** เหตุผลของ reject / หมายเหตุของคำโต้แย้งและผลวิชา (api-contract §7.4 — Lifecycle `APPLICATION_LIMITS`) */
export const REASON_MAX = 2000;
export const NOTE_MAX = 5000;

export const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';
export const primaryButton = 'rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover active:scale-[0.97] disabled:opacity-60';
export const secondaryButton = 'rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted active:scale-[0.97] disabled:opacity-60';

export type Message = { tone: 'error' | 'success'; text: string };

export function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'REASON_REQUIRED') return 'กรุณาระบุเหตุผล';
  if (cause.issues.includes('ACADEMIC_RESULT_ALREADY_RECORDED')) return 'บันทึกผลวิชาของใบสมัครนี้ไว้แล้ว';
  if (cause.issues.includes('DISPUTE_WINDOW_OPEN')) return 'ยังอยู่ในช่วง 7 วันที่นักศึกษาโต้แย้งผลได้ บันทึกผลวิชาได้หลังพ้นช่วงนี้';
  if (cause.code === 'STATE_CONFLICT') return 'สถานะของรายการนี้เปลี่ยนไปแล้ว โหลดรายการใหม่ให้แล้ว';
  if (cause.issues.includes('COMPANY_FAIL_CANNOT_BECOME_PASS')) return 'บริษัทประเมินไม่ผ่าน จึงบันทึกผลวิชาเป็น "ผ่าน" ไม่ได้';
  return cause.message;
}

/** หัวรายการใบสมัครของนักศึกษา (ชื่อ ตำแหน่ง บริษัท ช่วงฝึก ป้ายเตือน) ใช้ร่วมกันทุกหน้าของอาจารย์ */
export function ApplicationSummary({ app }: { app: AdvisorApplicationItem }) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="font-semibold">{app.student_name}</p>
        <p className="text-sm text-ink-soft">{app.job_title} · {app.company_name}</p>
        <p className="mt-1 text-xs text-ink-soft">
          {app.start_date && app.end_date ? `ช่วงฝึก ${formatDate(app.start_date)} – ${formatDate(app.end_date)}` : `สมัครเมื่อ ${formatDate(app.created_at)}`}
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {app.major_mismatch && <StatusBadge tone="warning" icon={AlertTriangle}>สาขาไม่ตรงกับประกาศ</StatusBadge>}
          {app.flagged_for_advisor && <StatusBadge tone="danger" icon={AlertTriangle}>ประกาศถูกตีกลับหรือบริษัทถูกระงับ</StatusBadge>}
          {app.frozen && <StatusBadge tone="neutral">ประกาศถูกระงับชั่วคราว</StatusBadge>}
        </div>
      </div>
      <ApplicationStatusBadge status={app.status} />
    </div>
  );
}

/** เปิดเรซูเม่ที่นักศึกษาส่ง (`GET /advisor/applications/{id}/resume` — URL อายุสั้น) */
export function ResumeButton({ applicationId, onError }: { applicationId: string; onError: (text: string) => void }) {
  const { request } = useAuth();
  const [busy, setBusy] = useState(false);
  async function open() {
    setBusy(true);
    try {
      const { url } = await request<ResumeUrlResponse>(`/advisor/applications/${encodeURIComponent(applicationId)}/resume`);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (cause) { onError(failure(cause)); }
    finally { setBusy(false); }
  }
  return (
    <button type="button" disabled={busy} onClick={() => void open()} className="inline-flex items-center gap-1.5 text-sm font-medium text-primary hover:underline disabled:opacity-60">
      <FileText aria-hidden="true" className="h-4 w-4" />{busy ? 'กำลังเปิด…' : 'ดูเรซูเม่'}
    </button>
  );
}

export function Pager({ page, total, onPage }: { page: number; total: number; onPage: (page: number) => void }) {
  const last = Math.max(1, Math.ceil(total / PAGE_SIZE));
  if (total === 0) return null;
  return (
    <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
      <span>ทั้งหมด {total} รายการ · หน้า {page} จาก {last}</span>
      <span className="flex gap-2">
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-muted disabled:opacity-50">ก่อนหน้า</button>
        <button type="button" disabled={page >= last} onClick={() => onPage(page + 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-muted disabled:opacity-50">ถัดไป</button>
      </span>
    </div>
  );
}
