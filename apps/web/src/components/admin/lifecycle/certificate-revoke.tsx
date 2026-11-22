'use client';

import { useId, useState } from 'react';
import type { FormEvent } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import type { CertificateItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { LIFECYCLE_REASON_MAX, ReasonField } from '@/components/admin/lifecycle/reason-field';
import { formatDate } from '@/components/student/application-ui';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';

type Message = { tone: 'error' | 'success'; text: string };

function searchFailure(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === 'VALIDATION_FAILED') return 'รหัสใบรับรองไม่ถูกต้อง';
  return cause instanceof ApiError ? cause.message : 'ค้นหาไม่สำเร็จ กรุณาลองใหม่';
}

function revokeFailure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'เพิกถอนไม่สำเร็จ กรุณาลองใหม่';
  if (cause.status === 404) return 'ไม่พบใบรับรองนี้';
  if (cause.issues.includes('ALREADY_REVOKED')) return 'ใบรับรองนี้ถูกเพิกถอนไปแล้ว';
  if (cause.code === 'REASON_REQUIRED') return 'กรุณากรอกเหตุผล';
  return cause.message;
}

/**
 * Admin ค้นใบรับรองจากรหัสบนใบ (`IP-…`) แล้วเพิกถอนจากผลที่เจอ (README §5.4/§5.10) — ไม่ต้องกรอก UUID เอง
 * - ค้น: `GET /admin/lifecycle/certificates?code=` (เทียบตรงตัว ไม่สนตัวพิมพ์/ช่องว่าง; ไม่พบ ⇒ `data: []`)
 * - เพิกถอน: `POST /admin/lifecycle/certificates/{id}/actions/revoke` `{reason}` — หลังเพิกถอน หน้าตรวจสอบสาธารณะแสดง "ถูกเพิกถอน"
 */
export function CertificateRevoke() {
  const { request } = useAuth();
  const fieldId = useId();
  const [code, setCode] = useState('');
  const [searched, setSearched] = useState<string | null>(null);
  const [results, setResults] = useState<CertificateItem[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [message, setMessage] = useState<Message | null>(null);

  async function find(target: string): Promise<CertificateItem[]> {
    const page = await request<Paginated<CertificateItem>>(`/admin/lifecycle/certificates?code=${encodeURIComponent(target)}`);
    return page.data;
  }

  async function search(event: FormEvent) {
    event.preventDefault();
    const target = code.trim();
    setMessage(null);
    if (!target) { setMessage({ tone: 'error', text: 'กรุณากรอกรหัสใบรับรอง' }); return; }
    setSearching(true);
    try {
      setResults(await find(target));
      setSearched(target);
    } catch (cause) {
      setResults(null);
      setSearched(null);
      setMessage({ tone: 'error', text: searchFailure(cause) });
    } finally {
      setSearching(false);
    }
  }

  async function revoke(item: CertificateItem, reason: string) {
    setMessage(null);
    try {
      const updated = await request<CertificateItem>(`/admin/lifecycle/certificates/${encodeURIComponent(item.id)}/actions/revoke`, { method: 'POST', body: { reason } });
      setResults((rows) => rows?.map((row) => (row.id === updated.id ? updated : row)) ?? rows);
      setMessage({ tone: 'success', text: `เพิกถอนใบรับรอง ${updated.certificate_code} (${updated.company_name}) แล้ว` });
    } catch (cause) {
      // ถูกเพิกถอนไปแล้วจากที่อื่น (เช่น HR) ⇒ โหลดสถานะใหม่ให้ตรงความจริง ฟอร์มในการ์ดจะหายไป จึงแสดงข้อความระดับหน้า
      if (cause instanceof ApiError && cause.issues.includes('ALREADY_REVOKED') && searched) {
        await find(searched).then(setResults).catch(() => undefined);
        setMessage({ tone: 'error', text: revokeFailure(cause) });
        return;
      }
      throw new Error(revokeFailure(cause));
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">ใบรับรอง</h1>
      <p className="mt-1 text-sm text-ink-soft">
        ค้นใบรับรองจากรหัสบนใบ แล้วเพิกถอนใบที่ออกผิดหรือพบการทุจริต หลังเพิกถอน หน้าตรวจสอบใบรับรองสาธารณะจะแสดงว่า &quot;ถูกเพิกถอน&quot; ทุกการกระทำบันทึก Audit log และย้อนกลับไม่ได้
      </p>

      <form onSubmit={(event) => void search(event)} noValidate role="search" aria-label="ค้นหาใบรับรอง" className="mt-5 flex max-w-xl flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <label htmlFor={`${fieldId}-code`} className="font-medium">รหัสใบรับรอง</label>
          <input id={`${fieldId}-code`} value={code} onChange={(event) => setCode(event.target.value)} spellCheck={false} autoComplete="off"
            placeholder="IP-2026-XXXXXXXX" maxLength={100} aria-describedby={`${fieldId}-hint`}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-sm uppercase outline-none placeholder:normal-case focus:border-primary focus:ring-2 focus:ring-primary-soft" />
          <p id={`${fieldId}-hint`} className="mt-1 text-xs text-ink-soft">รหัสที่พิมพ์บนใบรับรองและใน QR ไม่สนตัวพิมพ์เล็ก-ใหญ่</p>
        </div>
        <button type="submit" disabled={searching} className="mb-5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">
          {searching ? 'กำลังค้นหา…' : 'ค้นหา'}
        </button>
      </form>

      {message && <div className="mt-4 max-w-xl"><Notice tone={message.tone}>{message.text}</Notice></div>}

      {results && searched && (
        <section aria-live="polite" className="mt-5 max-w-xl">
          {results.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border p-8 text-center">
              <p className="font-semibold">ไม่พบใบรับรองรหัส <span className="font-mono">{searched}</span></p>
              <p className="mt-1 text-sm text-ink-soft">ตรวจรหัสให้ครบทุกตัวอักษร (รูปแบบ IP-ปี-ตัวอักษร 8 ตัว)</p>
            </div>
          ) : (
            <ul className="space-y-4">
              {results.map((item) => <CertificateCard key={item.id} item={item} onRevoke={revoke} />)}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

function CertificateCard({ item, onRevoke }: { item: CertificateItem; onRevoke: (item: CertificateItem, reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    const text = reason.trim();
    setError('');
    if (!text) { setError('กรุณากรอกเหตุผล'); return; }
    if (text.length > LIFECYCLE_REASON_MAX) { setError(`เหตุผลต้องไม่เกิน ${LIFECYCLE_REASON_MAX} ตัวอักษร`); return; }
    if (!window.confirm(`เพิกถอนใบรับรอง ${item.certificate_code} ของ ${item.company_name}? ย้อนกลับไม่ได้`)) return;
    setBusy(true);
    try {
      await onRevoke(item, text);
      setReason('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'เพิกถอนไม่สำเร็จ กรุณาลองใหม่');
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{item.job_title}</h2>
          <p className="text-sm text-ink-soft">{item.company_name}</p>
        </div>
        {item.status === 'VALID'
          ? <StatusBadge tone="success" icon={CircleCheck}>ใช้ได้</StatusBadge>
          : <StatusBadge tone="danger" icon={CircleX}>ถูกเพิกถอน</StatusBadge>}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-4 text-sm sm:grid-cols-[auto_1fr_auto_auto]">
        <div className="col-span-2 sm:col-span-1"><dt className="text-xs text-ink-soft">รหัสใบรับรอง</dt><dd className="mt-0.5 whitespace-nowrap font-mono font-medium">{item.certificate_code}</dd></div>
        <div><dt className="text-xs text-ink-soft">ช่วงฝึกงาน</dt><dd className="mt-0.5 font-medium">{formatDate(item.period.start)} – {formatDate(item.period.end)}</dd></div>
        <div><dt className="text-xs text-ink-soft">ฝึกจริง</dt><dd className="mt-0.5 font-medium">{item.actual_days} วัน</dd></div>
        <div><dt className="text-xs text-ink-soft">ออกเมื่อ</dt><dd className="mt-0.5 font-medium">{formatDate(item.issued_at)}</dd></div>
      </dl>

      {item.status === 'VALID' ? (
        <form onSubmit={(event) => void submit(event)} noValidate aria-label={`เพิกถอนใบรับรอง ${item.certificate_code}`} className="mt-4 border-t border-border pt-4">
          <ReasonField label="เหตุผลที่เพิกถอน" value={reason} onChange={setReason} required rows={2} />
          {error && <div className="mt-2"><Notice tone="error">{error}</Notice></div>}
          <button type="submit" disabled={busy} className="mt-3 rounded-full bg-danger px-4 py-2 text-sm font-semibold text-white hover:opacity-90 disabled:opacity-50">
            {busy ? 'กำลังดำเนินการ…' : 'เพิกถอนใบรับรอง'}
          </button>
        </form>
      ) : (
        <p className="mt-4 border-t border-border pt-4 text-sm text-ink-soft">ใบรับรองนี้ถูกเพิกถอนแล้ว (เพิกถอนซ้ำไม่ได้ และออกใบใหม่ให้ใบสมัครเดิมไม่ได้)</p>
      )}
    </li>
  );
}
