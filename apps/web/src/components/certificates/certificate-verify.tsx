'use client';

import { BadgeCheck, CircleX, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { PublicCertificateResponse } from '@internpath/contracts';
import { StatusBadge } from '@/components/ui/status-badge';
import { formatDate } from '@/components/student/application-ui';
import { ApiError, apiRequest } from '@/lib/api';

type Lookup =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'found'; certificate: PublicCertificateResponse }
  | { state: 'missing' }
  | { state: 'error'; text: string };

/**
 * หน้าตรวจสอบ E-Certificate สาธารณะ (README §5.4, api-contract §7.5) — ไม่ต้องล็อกอิน
 * - QR ในใบรับรองชี้มาที่ `/public/certificates?code={certificate_code}` แล้วหน้านี้เรียก `GET /public/certificates/{code}`
 * - แสดงเฉพาะสถานะ ชื่อผู้ถือ บริษัท ตำแหน่ง ช่วงฝึก (ไม่มี PII อื่น) • ไม่พบหรือรูปแบบผิด ⇒ 404 แบบเดียวกัน
 */
export function CertificateVerify() {
  const params = useSearchParams();
  const router = useRouter();
  const code = (params.get('code') ?? '').trim();
  const [input, setInput] = useState(code);
  const [lookup, setLookup] = useState<Lookup>({ state: 'idle' });

  useEffect(() => {
    setInput(code);
    if (!code) { setLookup({ state: 'idle' }); return; }
    let active = true;
    setLookup({ state: 'loading' });
    apiRequest<PublicCertificateResponse>(`/public/certificates/${encodeURIComponent(code)}`)
      .then((certificate) => { if (active) setLookup({ state: 'found', certificate }); })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 404) setLookup({ state: 'missing' });
        else if (cause instanceof ApiError && cause.status === 429) setLookup({ state: 'error', text: 'ตรวจสอบบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่' });
        else setLookup({ state: 'error', text: cause instanceof ApiError ? cause.message : 'ตรวจสอบไม่สำเร็จ กรุณาลองใหม่' });
      });
    return () => { active = false; };
  }, [code]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = input.trim();
    if (!value) return;
    router.push(`/public/certificates?code=${encodeURIComponent(value)}`);
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-12 sm:px-6">
      <h1 className="text-3xl font-semibold">ตรวจสอบใบรับรองการฝึกงาน</h1>
      <p className="mt-2 text-sm text-ink-soft">กรอกรหัสใบรับรอง (Certificate ID) ที่พิมพ์อยู่บนใบรับรอง หรือสแกน QR Code บนใบรับรอง</p>

      <form onSubmit={submit} className="mt-6 flex flex-col gap-3 sm:flex-row">
        <label className="flex-1">
          <span className="sr-only">รหัสใบรับรอง</span>
          <input value={input} onChange={(event) => setInput(event.target.value)} placeholder="รหัสใบรับรอง" autoComplete="off" spellCheck={false}
            className="w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
        </label>
        <button type="submit" className="inline-flex items-center justify-center gap-2 rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover active:scale-[0.97]">
          <Search aria-hidden="true" className="h-4 w-4" />ตรวจสอบ
        </button>
      </form>

      <div aria-live="polite" className="mt-8">
        {lookup.state === 'loading' && <p className="text-sm text-ink-soft">กำลังตรวจสอบ…</p>}
        {lookup.state === 'missing' && (
          <section className="rounded-xl bg-surface-muted p-6">
            <StatusBadge tone="danger" icon={CircleX}>ไม่พบใบรับรอง</StatusBadge>
            <p className="mt-3 text-sm text-ink-soft">ไม่พบใบรับรองที่ตรงกับรหัสนี้ ตรวจรหัสอีกครั้ง ถ้ายังไม่พบ ใบรับรองนี้อาจไม่ได้ออกโดย InternPath</p>
          </section>
        )}
        {lookup.state === 'error' && <p role="alert" className="rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-text">{lookup.text}</p>}
        {lookup.state === 'found' && <CertificateCard code={code} certificate={lookup.certificate} />}
      </div>
    </main>
  );
}

function CertificateCard({ code, certificate }: { code: string; certificate: PublicCertificateResponse }) {
  const valid = certificate.status === 'VALID';
  return (
    <section aria-labelledby="certificate-result" className="rounded-xl bg-surface-muted p-6">
      <h2 id="certificate-result" className="sr-only">ผลการตรวจสอบ</h2>
      {valid
        ? <StatusBadge tone="success" icon={BadgeCheck}>ใบรับรองถูกต้อง</StatusBadge>
        : <StatusBadge tone="danger" icon={CircleX}>ใบรับรองถูกเพิกถอนแล้ว</StatusBadge>}
      {!valid && <p className="mt-3 text-sm text-danger-text">ใบรับรองนี้ถูกเพิกถอนและใช้อ้างอิงไม่ได้แล้ว</p>}
      <dl className="mt-5 grid gap-4 sm:grid-cols-2">
        <div className="sm:col-span-2"><dt className="text-xs text-ink-soft">ผู้ถือใบรับรอง</dt><dd className="mt-0.5 text-xl font-semibold">{certificate.holder_name}</dd></div>
        <div><dt className="text-xs text-ink-soft">บริษัท</dt><dd className="mt-0.5 font-medium">{certificate.company_name}</dd></div>
        <div><dt className="text-xs text-ink-soft">ตำแหน่ง</dt><dd className="mt-0.5 font-medium">{certificate.job_title}</dd></div>
        <div><dt className="text-xs text-ink-soft">ช่วงฝึกงาน</dt><dd className="mt-0.5 font-medium">{formatDate(certificate.period.start)} – {formatDate(certificate.period.end)}</dd></div>
        <div><dt className="text-xs text-ink-soft">รหัสใบรับรอง</dt><dd className="mt-0.5 break-all font-mono text-sm">{code}</dd></div>
      </dl>
    </section>
  );
}
