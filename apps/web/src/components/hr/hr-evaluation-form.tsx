'use client';

import { CircleCheck, CircleX } from 'lucide-react';
import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import type { ApplicationStatus, HrEvaluateRequest } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

/** Lifecycle `APPLICATION_LIMITS` — `reason` ≤ 2000, `note` ≤ 5000 */
const REASON_MAX = 2000;
const NOTE_MAX = 5000;

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'บันทึกผลประเมินไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'REASON_REQUIRED') return 'การประเมินไม่ผ่านต้องระบุเหตุผล';
  if (cause.code === 'STATE_CONFLICT') return 'สถานะของใบสมัครเปลี่ยนไปแล้ว โหลดข้อมูลใหม่ให้แล้ว';
  return cause.message;
}

/**
 * ฟอร์ม HR ประเมินผลการฝึกงาน (README §5.2, UAT-07/21) — เสียบในหน้าผู้สมัคร (`applicant-detail.tsx`) เมื่อมี action `evaluate`
 * - `POST /hr/applications/{id}/actions/evaluate` `{result: PASS|FAIL, reason?, note?}` — FAIL ต้องมีเหตุผล
 * - `REEVALUATION_REQUESTED` = ประเมินซ้ำหลังอาจารย์รับคำโต้แย้ง (ได้รอบเดียว)
 * - ทำเสร็จหรือชนกัน ⇒ เรียก `onChanged` ให้หน้าผู้สมัครโหลดสถานะใหม่ (ปุ่มออกใบรับรองจะขึ้นเองเมื่อผ่านและฝึกครบเกณฑ์)
 */
export function HrEvaluationForm({ applicationId, status, studentLabel, onChanged }: {
  applicationId: string;
  status: ApplicationStatus;
  studentLabel?: string;
  onChanged: () => Promise<void> | void;
}) {
  const { request } = useAuth();
  const fieldId = useId();
  const [result, setResult] = useState<'PASS' | 'FAIL' | null>(null);
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const reevaluation = status === 'REEVALUATION_REQUESTED';

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!result) { setMessage({ tone: 'error', text: 'กรุณาเลือกผลประเมิน' }); return; }
    const reasonValue = reason.trim();
    const noteValue = note.trim();
    if (result === 'FAIL' && !reasonValue) { setMessage({ tone: 'error', text: 'การประเมินไม่ผ่านต้องระบุเหตุผล' }); return; }
    if (reasonValue.length > REASON_MAX) { setMessage({ tone: 'error', text: `เหตุผลต้องไม่เกิน ${REASON_MAX} ตัวอักษร` }); return; }
    if (noteValue.length > NOTE_MAX) { setMessage({ tone: 'error', text: `หมายเหตุต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }
    const who = studentLabel ? ` ${studentLabel}` : '';
    const question = result === 'PASS'
      ? `ยืนยันประเมิน${who} "ผ่าน"? บันทึกแล้วแก้ไม่ได้`
      : `ยืนยันประเมิน${who} "ไม่ผ่าน"? นักศึกษาโต้แย้งผลได้ภายใน 7 วัน`;
    if (!window.confirm(question)) return;

    setBusy(true);
    setMessage(null);
    try {
      const body: HrEvaluateRequest = {
        result, ...(reasonValue ? { reason: reasonValue } : {}), ...(noteValue ? { note: noteValue } : {}),
      };
      await request(`/hr/applications/${encodeURIComponent(applicationId)}/actions/evaluate`, { method: 'POST', body });
      setMessage({ tone: 'success', text: result === 'PASS' ? 'บันทึกผล "ผ่าน" แล้ว' : 'บันทึกผล "ไม่ผ่าน" แล้ว' });
      await onChanged();
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
      await onChanged();
    } finally { setBusy(false); }
  }

  const choice = (value: 'PASS' | 'FAIL', label: string, Icon: typeof CircleCheck, tone: string) => (
    <label className={`flex flex-1 cursor-pointer items-center gap-2 rounded-xl border px-4 py-3 font-medium has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-primary ${result === value ? `border-primary bg-primary-soft` : 'border-border bg-surface'}`}>
      <input type="radio" name={`${fieldId}-result`} value={value} checked={result === value} onChange={() => setResult(value)} className="sr-only" />
      <Icon aria-hidden="true" className={`h-5 w-5 ${tone}`} strokeWidth={2.5} />
      {label}
    </label>
  );

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-labelledby="hr-evaluation-title" className="mt-4 space-y-4 rounded-xl bg-surface-muted p-4 text-sm">
      <div>
        <h3 id="hr-evaluation-title" className="text-base font-semibold">{reevaluation ? 'ประเมินผลใหม่ (รอบที่ 2)' : 'ประเมินผลการฝึกงาน'}</h3>
        <p className="mt-1 text-xs text-ink-soft">
          {reevaluation
            ? 'อาจารย์ที่ปรึกษารับคำโต้แย้งของนักศึกษา และขอให้บริษัทประเมินใหม่อีก 1 รอบ ผลรอบนี้เป็นผลสุดท้าย'
            : 'ผลประเมินแสดงคู่กับรีวิวของนักศึกษา ถ้าไม่ผ่านต้องระบุเหตุผล และนักศึกษาโต้แย้งได้ภายใน 7 วัน'}
        </p>
      </div>
      <fieldset>
        <legend className="sr-only">ผลประเมิน</legend>
        <div className="flex flex-col gap-3 sm:flex-row">
          {choice('PASS', 'ผ่าน', CircleCheck, 'text-success')}
          {choice('FAIL', 'ไม่ผ่าน', CircleX, 'text-danger')}
        </div>
      </fieldset>
      <div>
        <label htmlFor={`${fieldId}-reason`} className="block font-medium">
          เหตุผล{result === 'FAIL' ? '' : ' (ไม่บังคับ)'}
          {result === 'FAIL' && <span aria-hidden="true" className="text-danger"> *</span>}
        </label>
        <textarea id={`${fieldId}-reason`} value={reason} onChange={(event) => setReason(event.target.value)} rows={3} maxLength={REASON_MAX}
          aria-required={result === 'FAIL'} aria-describedby={`${fieldId}-reason-hint`} className={inputClass} />
        <p id={`${fieldId}-reason-hint`} className="mt-1 text-xs text-ink-soft">{reason.length}/{REASON_MAX} · นักศึกษาและอาจารย์เห็นเหตุผลนี้</p>
      </div>
      <div>
        <label htmlFor={`${fieldId}-note`} className="block font-medium">หมายเหตุเพิ่มเติม (ไม่บังคับ)</label>
        <textarea id={`${fieldId}-note`} value={note} onChange={(event) => setNote(event.target.value)} rows={2} maxLength={NOTE_MAX}
          aria-describedby={`${fieldId}-note-hint`} className={inputClass} />
        <p id={`${fieldId}-note-hint`} className="mt-1 text-xs text-ink-soft">{note.length}/{NOTE_MAX}</p>
      </div>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <button type="submit" disabled={busy} className="rounded-full bg-primary px-5 py-2 font-semibold text-white hover:bg-primary-hover active:scale-[0.97] disabled:opacity-60">
        {busy ? 'กำลังบันทึก…' : 'บันทึกผลประเมิน'}
      </button>
    </form>
  );
}
