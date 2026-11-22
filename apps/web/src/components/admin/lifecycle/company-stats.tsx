'use client';

import Link from 'next/link';
import { useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import type { CompanyLifecycleStats } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * สถิติถอนข้อเสนอ/ยุติการฝึกของบริษัท — สัญญาณให้ Admin ตรวจสอบบริษัท (README §5.2.2, §11)
 * `GET /admin/lifecycle/company-stats/{company_id}` → `{company_id, rescinded_count, terminated_count}` (ไม่มีใบ ⇒ 0)
 * รหัสบริษัทอยู่ใน URL (`?company_id=`) เพื่อให้หน้าอื่นลิงก์มาได้ • API ไม่คืนชื่อบริษัท จึงแสดงรหัส
 */
export function CompanyStats() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const fieldId = useId();
  const companyId = (searchParams.get('company_id') ?? '').trim();
  const validId = UUID.test(companyId);

  const [input, setInput] = useState(companyId);
  const [stats, setStats] = useState<CompanyLifecycleStats | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setInput(companyId); }, [companyId]);

  useEffect(() => {
    setStats(null);
    setError(companyId && !validId ? 'รหัสบริษัทต้องเป็น UUID' : '');
    if (!validId) return;
    let active = true;
    setLoading(true);
    request<CompanyLifecycleStats>(`/admin/lifecycle/company-stats/${encodeURIComponent(companyId)}`)
      .then((data) => { if (active) setStats(data); })
      .catch((cause) => { if (active) setError(cause instanceof ApiError ? cause.message : 'โหลดสถิติไม่สำเร็จ'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [companyId, validId, request]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const id = input.trim();
    if (!UUID.test(id)) { setError('รหัสบริษัทต้องเป็น UUID'); return; }
    router.replace(`${pathname}?company_id=${encodeURIComponent(id)}`);
  }

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold">สถิติบริษัท</h1>
        <p className="mt-1 text-sm text-ink-soft">
          จำนวนครั้งที่บริษัทถอนข้อเสนอหลังตอบรับ และการฝึกงานที่ถูกยุติกลางคัน ใช้เป็นสัญญาณประกอบการตรวจสอบบริษัท ไม่ได้ตัดสินโดยอัตโนมัติ
        </p>
      </div>

      <form onSubmit={submit} noValidate role="search" aria-label="ค้นสถิติบริษัท" className="flex max-w-xl flex-wrap items-end gap-3">
        <div className="min-w-0 flex-1 text-sm">
          <label htmlFor={`${fieldId}-company`} className="font-medium">รหัสบริษัท (UUID)</label>
          <input id={`${fieldId}-company`} value={input} onChange={(event) => setInput(event.target.value)} spellCheck={false} autoComplete="off"
            maxLength={36} aria-describedby={`${fieldId}-hint`}
            className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 font-mono text-xs outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
          <p id={`${fieldId}-hint`} className="mt-1 text-xs text-ink-soft">รหัสบริษัทในระบบ (เช่น จากธงบริษัทหรือ Audit log)</p>
        </div>
        <button type="submit" disabled={loading} className="mb-5 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-50">
          {loading ? 'กำลังโหลด…' : 'ดูสถิติ'}
        </button>
      </form>

      {error && <div className="max-w-xl"><Notice tone="error">{error}</Notice></div>}

      {stats && (
        <section aria-live="polite" aria-labelledby={`${fieldId}-result`} className="max-w-xl rounded-xl border border-border bg-surface p-5">
          <h2 id={`${fieldId}-result`} className="text-sm text-ink-soft">
            บริษัท <span className="break-all font-mono text-ink">{stats.company_id}</span>
          </h2>
          <dl className="mt-4 grid grid-cols-2 gap-4">
            <div className="rounded-lg bg-surface-muted p-4">
              <dt className="text-sm text-ink-soft">ถอนข้อเสนอ</dt>
              <dd className="mt-1 text-3xl font-semibold">{stats.rescinded_count}</dd>
              <dd className="mt-1 text-xs text-ink-soft">ใบสมัครสถานะ &quot;บริษัทถอนข้อเสนอ&quot;</dd>
            </div>
            <div className="rounded-lg bg-surface-muted p-4">
              <dt className="text-sm text-ink-soft">ยุติการฝึกกลางคัน</dt>
              <dd className="mt-1 text-3xl font-semibold">{stats.terminated_count}</dd>
              <dd className="mt-1 text-xs text-ink-soft">ทุกฝ่ายที่ยุติ (บริษัท นักศึกษา อาจารย์ ผู้ดูแล)</dd>
            </div>
          </dl>
          <p className="mt-4 text-sm">
            <Link href="/admin/flags" className="font-medium text-primary hover:underline">ไปที่ธงบริษัท</Link>
            <span className="text-ink-soft"> เพื่อติดธงหรือดูประวัติการตรวจสอบของบริษัทนี้</span>
          </p>
        </section>
      )}
    </div>
  );
}
