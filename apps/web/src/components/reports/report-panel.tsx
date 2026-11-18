'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import type { JobReportCategory, ReportCreatedResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

// ขีดจำกัดตาม api-contract §6.4 — ค่าจริงตรวจที่ Verification
const JOB_DETAIL = { min: 20, max: 1000 };
const REVIEW_REASON = { min: 10, max: 1000 };

const JOB_CATEGORIES: Array<[JobReportCategory, string]> = [
  ['SCAM_OR_FEE', 'เรียกเก็บเงินหรือหลอกลวง'],
  ['MISLEADING_INFO', 'ข้อมูลเท็จหรือชวนเข้าใจผิด'],
  ['INAPPROPRIATE_CONTENT', 'เนื้อหาไม่เหมาะสม'],
  ['DUPLICATE_OR_SPAM', 'ซ้ำหรือสแปม'],
  ['OTHER', 'อื่น ๆ'],
];

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

function describe(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ส่งรายงานไม่สำเร็จ กรุณาลองใหม่';
  switch (cause.code) {
    case 'ALREADY_REPORTED': return 'คุณรายงานรายการนี้ไปแล้ว';
    case 'JOB_NOT_REPORTABLE': return 'รายงานได้เฉพาะประกาศที่เปิดรับสมัครหรือปิดรับแล้ว';
    case 'REVIEW_NOT_REPORTABLE': return 'รีวิวนี้รายงานไม่ได้แล้ว (ถูกพักหรือถูกลบ)';
    case 'RATE_LIMITED': return 'รายงานถี่เกินไป กรุณาลองใหม่ภายหลัง (จำกัด 5 ครั้งต่อวัน)';
    case 'FORBIDDEN_ROLE': return 'บัญชีนี้รายงานรายการนี้ไม่ได้ (บริษัทรายงานได้เฉพาะรีวิวของบริษัทตน)';
    case 'NOT_FOUND': return 'ไม่พบรายการที่จะรายงาน อาจถูกลบไปแล้ว';
    case 'VALIDATION_FAILED': return 'ข้อมูลที่ส่งไม่ถูกต้อง กรุณาตรวจสอบแล้วลองใหม่';
    default: return cause.message;
  }
}

/**
 * ปุ่มรายงานประกาศ (`POST /jobs/{id}/reports`, นักศึกษา) และรีวิว (`POST /reviews/{id}/reports`, นักศึกษาและ HR)
 * ผู้เยี่ยมชม/บทบาทอื่น: ประกาศ ⇒ ลิงก์เข้าสู่ระบบ; ไม่ใช่บทบาทที่รายงานได้ ⇒ ไม่แสดงปุ่ม
 * ไม่บอกผู้รายงานว่ารายงานนับเข้าเกณฑ์ระงับหรือไม่ (Response ไม่มีฟิลด์นั้น — สัญญา §6.4)
 */
export function ReportPanel({ kind, targetId, loginNext }: { kind: 'job' | 'review'; targetId: string; loginNext?: string }) {
  const { ready, user, request } = useAuth();
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<JobReportCategory>('SCAM_OR_FEE');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const limits = kind === 'job' ? JOB_DETAIL : REVIEW_REASON;
  const label = kind === 'job' ? 'รายงานประกาศนี้' : 'รายงานรีวิว';

  if (!ready) return null;
  if (!user) {
    return loginNext ? (
      <Link href={`/login?next=${encodeURIComponent(loginNext)}`} className="text-sm font-medium text-ink-soft hover:text-primary hover:underline">เข้าสู่ระบบเพื่อ{label}</Link>
    ) : null;
  }
  const allowed = kind === 'job' ? user.role === 'STUDENT' : user.role === 'STUDENT' || user.role === 'COMPANY_HR';
  if (!allowed) return null;
  if (done) return <p role="status" className="text-sm text-success-text">ส่งรายงานแล้ว ผู้ดูแลระบบจะตรวจสอบ ขอบคุณที่ช่วยดูแลชุมชน</p>;
  if (!open) {
    return <button type="button" onClick={() => setOpen(true)} className="text-sm font-medium text-ink-soft hover:text-danger-text hover:underline">{label}</button>;
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value.length < limits.min) { setError(`กรุณาอธิบายอย่างน้อย ${limits.min} ตัวอักษร`); return; }
    if (value.length > limits.max) { setError(`ข้อความต้องไม่เกิน ${limits.max} ตัวอักษร`); return; }
    setBusy(true);
    setError(null);
    try {
      const body = kind === 'job' ? { category, detail: value } : { reason: value };
      const path = kind === 'job' ? `/jobs/${encodeURIComponent(targetId)}/reports` : `/reviews/${encodeURIComponent(targetId)}/reports`;
      await request<ReportCreatedResponse>(path, { method: 'POST', body });
      setDone(true);
    } catch (cause) { setError(describe(cause)); }
    finally { setBusy(false); }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="space-y-3 rounded-xl border border-border p-4 text-sm">
      <h3 className="font-semibold">{label}</h3>
      <p className="text-xs text-ink-soft">รายงานจะถูกตรวจสอบโดยผู้ดูแลระบบ ผู้ถูกรายงานไม่เห็นว่าใครเป็นผู้รายงาน และรายงานได้ 1 ครั้งต่อรายการ</p>
      {kind === 'job' && (
        <label className="block font-medium">
          ประเภท
          <select value={category} onChange={(event) => setCategory(event.target.value as JobReportCategory)} className={inputClass}>
            {JOB_CATEGORIES.map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
        </label>
      )}
      <label className="block font-medium">
        {kind === 'job' ? 'รายละเอียด' : 'เหตุผล'}
        <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} className={inputClass} />
        <span className="mt-1 block text-xs font-normal text-ink-soft">{text.length}/{limits.max} (อย่างน้อย {limits.min} ตัวอักษร)</span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-lg bg-danger-text px-5 py-2 font-semibold text-white hover:opacity-90 disabled:opacity-60">{busy ? 'กำลังส่ง…' : 'ส่งรายงาน'}</button>
        <button type="button" onClick={() => { setOpen(false); setError(null); }} className="rounded-lg border border-border px-5 py-2 font-semibold hover:bg-surface-muted">ยกเลิก</button>
      </div>
    </form>
  );
}
