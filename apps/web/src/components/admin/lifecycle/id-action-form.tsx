'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { Notice } from '@/components/admin/filter-fields';
import { LIFECYCLE_REASON_MAX, ReasonField } from '@/components/admin/lifecycle/reason-field';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ฟอร์ม action ของ Admin ที่ต้องระบุเป้าหมายด้วยรหัส (UUID) + เหตุผลบังคับ — API ของ Lifecycle ไม่มีรายการให้เลือกสำหรับ
 * action เหล่านี้ (terminate / revoke / reapply-unlock) จึงรับรหัสจากหน้าอื่น (เช่น รายงานปัญหา, ผู้ใช้)
 * ตรวจรูปแบบ UUID และเหตุผลก่อนยิง API • ถาม `window.confirm` ก่อนทำเพราะย้อนกลับไม่ได้
 * `onSubmit` คืนข้อความสำเร็จ หรือโยน Error ที่มีข้อความสำหรับแสดง
 */
export function IdActionForm({ title, description, idLabel, reasonLabel, submitLabel, confirmText, initialId = '', onSubmit }: {
  title: string;
  description: string;
  idLabel: string;
  reasonLabel: string;
  submitLabel: string;
  confirmText: (id: string) => string;
  initialId?: string;
  onSubmit: (id: string, reason: string) => Promise<string>;
}) {
  const fieldId = useId();
  const [targetId, setTargetId] = useState(initialId);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const id = targetId.trim();
    const text = reason.trim();
    setError('');
    setSuccess('');
    if (!UUID.test(id)) { setError(`${idLabel}ต้องเป็น UUID`); return; }
    if (!text) { setError('กรุณากรอกเหตุผล'); return; }
    if (text.length > LIFECYCLE_REASON_MAX) { setError(`เหตุผลต้องไม่เกิน ${LIFECYCLE_REASON_MAX} ตัวอักษร`); return; }
    if (!window.confirm(confirmText(id))) return;
    setBusy(true);
    try {
      setSuccess(await onSubmit(id, text));
      setTargetId('');
      setReason('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate aria-labelledby={`${fieldId}-title`} className="rounded-xl border border-border bg-surface p-4">
      <h2 id={`${fieldId}-title`} className="text-base font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-ink-soft">{description}</p>
      <div className="mt-3 space-y-3">
        <div className="text-sm">
          <label htmlFor={`${fieldId}-id`} className="font-medium">{idLabel} (UUID) <span className="text-danger-text">(จำเป็น)</span></label>
          <input id={`${fieldId}-id`} value={targetId} onChange={(event) => setTargetId(event.target.value)} spellCheck={false} autoComplete="off"
            aria-required="true" maxLength={36}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
        </div>
        <ReasonField label={reasonLabel} value={reason} onChange={setReason} required rows={2} />
      </div>
      {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
      {success && <div className="mt-2"><Notice tone="success">{success}</Notice></div>}
      <button type="submit" disabled={busy} className="mt-3 rounded-full bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
        {busy ? 'กำลังดำเนินการ…' : submitLabel}
      </button>
    </form>
  );
}
