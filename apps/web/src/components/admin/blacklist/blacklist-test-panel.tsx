'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import type { BlacklistTestRequest, BlacklistTestResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Badge } from '@/components/admin/queue/queue-ui';
import { ApiError } from '@/lib/api';

const TEXT_MAX = 100_000;

const DECISION: Record<string, { label: string; badge: string }> = {
  APPROVE: { label: 'อนุมัติอัตโนมัติ', badge: 'bg-success-soft text-success-text' },
  PENDING_REVIEW: { label: 'เข้าคิวให้ Admin ตรวจ', badge: 'bg-warning-soft text-warning-text' },
  AUTO_REJECT: { label: 'ปฏิเสธอัตโนมัติ', badge: 'bg-danger-soft text-danger-text' },
};

/** ทดสอบข้อความกับกฎปัจจุบันก่อนใช้จริง — ไม่บันทึกอะไร และไม่นับกฎ "รายละเอียดสั้นเกินไป" (api-contract §6.3) */
export function BlacklistTestPanel() {
  const { request } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BlacklistTestResponse | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) { setError('กรุณากรอกข้อความที่ต้องการทดสอบ'); return; }
    if (text.length > TEXT_MAX) { setError(`ข้อความต้องไม่เกิน ${TEXT_MAX.toLocaleString('th-TH')} ตัวอักษร`); return; }
    setBusy(true);
    setError('');
    try {
      const body: BlacklistTestRequest = { text };
      setResult(await request<BlacklistTestResponse>('/admin/blacklist/test', { method: 'POST', body }));
    } catch (cause) {
      setResult(null);
      setError(cause instanceof ApiError ? cause.message : 'ทดสอบไม่สำเร็จ กรุณาลองใหม่');
    } finally { setBusy(false); }
  }

  const decision = result ? (DECISION[result.decision] ?? { label: result.decision, badge: 'bg-surface-muted text-ink-soft' }) : null;

  return (
    <section aria-labelledby="test-title" className="rounded-xl border border-border bg-surface p-4">
      <h2 id="test-title" className="text-sm font-semibold">ทดสอบข้อความกับกฎปัจจุบัน</h2>
      <p className="mt-1 text-xs text-ink-soft">ไม่บันทึกอะไรลงระบบ ใช้ดูว่าคำที่เพิ่มหรือปิดไว้ให้ผลอย่างไร (ไม่นับกฎ "รายละเอียดสั้นเกินไป")</p>
      <form onSubmit={(event) => void submit(event)} className="mt-3">
        <label className="block text-sm">
          <span className="sr-only">ข้อความที่ต้องการทดสอบ</span>
          <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4}
            placeholder="วางข้อความประกาศที่ต้องการทดสอบ เช่น ต้องจ่ายค่ามัดจำก่อนเริ่มงาน"
            className="w-full rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
        </label>
        <button type="submit" disabled={busy} className="mt-2 rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">
          {busy ? 'กำลังทดสอบ…' : 'ทดสอบ'}
        </button>
      </form>

      {error && <div className="mt-3"><Notice tone="error">{error}</Notice></div>}

      {result && decision && (
        <div className="mt-4 space-y-3 text-sm" aria-live="polite">
          <div className="flex flex-wrap items-center gap-2">
            <Badge className={decision.badge}>{decision.label}</Badge>
            <span className="text-ink-soft">ความเสี่ยง {result.risk_level} · คะแนน {result.risk_score}</span>
          </div>
          {result.matched_keywords.length > 0 ? (
            <div>
              <p className="text-xs font-medium text-ink-soft">คำที่จับได้</p>
              <ul className="mt-1 flex flex-wrap gap-1.5">
                {result.matched_keywords.map((keyword, index) => (
                  <li key={`${keyword.term}-${keyword.start}-${index}`}>
                    <mark className={keyword.negated
                      ? 'rounded bg-warning-soft px-1.5 py-0.5 text-xs text-warning-text underline decoration-dashed'
                      : 'rounded bg-danger-soft px-1.5 py-0.5 text-xs font-medium text-danger-text'}
                      title={keyword.negated ? 'อยู่ในประโยคปฏิเสธ (ไม่นับ)' : undefined}>
                      {keyword.term}{keyword.negated ? ' (ปฏิเสธ)' : ''}
                    </mark>
                  </li>
                ))}
              </ul>
            </div>
          ) : <p className="text-ink-soft">ไม่พบคำต้องห้ามในข้อความนี้</p>}
          {result.reasons.length > 0 && (
            <ul className="space-y-1">
              {result.reasons.map((reason, index) => (
                <li key={`${reason.code}-${index}`}>
                  <span className="font-mono text-xs text-ink-soft">{reason.code}</span> {reason.detail}
                  {reason.matched_text && <> — <mark className="rounded bg-danger-soft px-1 text-danger-text">{reason.matched_text}</mark></>}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}
