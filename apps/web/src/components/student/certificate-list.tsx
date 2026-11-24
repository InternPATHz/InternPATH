'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import type { CertificateDownloadResponse, CertificateItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { formatDate } from '@/components/student/application-ui';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';
import { asList } from '@/lib/list';

const failure = (cause: unknown) => (cause instanceof ApiError ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');

/**
 * ใบรับรองการฝึกงานของนักศึกษา (api-contract §7.5): `GET /me/certificates` (รวมใบที่ถูกเพิกถอน เพื่อให้เห็นสถานะ)
 * และ `GET /me/certificates/{id}/download` → Signed URL อายุ ~10 นาที — ขอใหม่ทุกครั้งที่กด ไม่เก็บลิงก์ไว้
 */
function verificationPath(code: string) {
  return `/public/certificates?code=${encodeURIComponent(code)}`;
}

function CertificateQr({ code }: { code: string }) {
  const [src, setSrc] = useState<string>();
  useEffect(() => {
    let active = true;
    const url = new URL(verificationPath(code), window.location.origin);
    void import('qrcode').then(({ toDataURL }) => toDataURL(url.href, { width: 144 }))
      .then((data) => { if (active) setSrc(data); }, () => undefined);
    return () => { active = false; };
  }, [code]);

  if (!src) return null;
  return (
    <Link href={verificationPath(code)} className="inline-flex shrink-0 rounded-lg bg-white p-1">
      <img src={src} alt="QR สำหรับตรวจสอบใบรับรอง" width={96} height={96} />
    </Link>
  );
}

export function CertificateList() {
  const { request } = useAuth();
  const [items, setItems] = useState<CertificateItem[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const result = await request<Paginated<CertificateItem> | CertificateItem[]>('/me/certificates?page=1&page_size=50');
      setItems(asList(result));
      setLoadError(null);
    } catch (cause) { setLoadError(failure(cause)); }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  async function download(item: CertificateItem) {
    setBusyId(item.id);
    setMessage(null);
    try {
      const { url } = await request<CertificateDownloadResponse>(`/me/certificates/${encodeURIComponent(item.id)}/download`);
      window.open(url, '_blank', 'noopener');
    } catch (cause) {
      // ใบถูกเพิกถอนระหว่างที่เปิดหน้านี้ ⇒ 409 CERTIFICATE_REVOKED — โหลดสถานะใหม่ให้ตรงความจริง
      const revoked = cause instanceof ApiError && cause.issues.includes('CERTIFICATE_REVOKED');
      setMessage({ tone: 'error', text: revoked ? 'ใบรับรองนี้ถูกเพิกถอนแล้ว ดาวน์โหลดไม่ได้' : failure(cause) });
      if (revoked) await load();
    } finally { setBusyId(null); }
  }

  async function copyVerificationLink(code: string) {
    const url = new URL(verificationPath(code), window.location.origin);
    try {
      await navigator.clipboard.writeText(url.href);
      setMessage({ tone: 'success', text: 'คัดลอกลิงก์ตรวจสอบแล้ว' });
    } catch { setMessage({ tone: 'error', text: 'คัดลอกไม่สำเร็จ เปิดลิงก์ตรวจสอบแล้วคัดลอกจากแถบที่อยู่ได้' }); }
  }

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ใบรับรองของฉัน</h1>
      <p className="mt-2 text-sm text-ink-soft">E-Certificate ที่บริษัทออกให้หลังฝึกงานเสร็จ บุคคลภายนอกตรวจสอบความถูกต้องได้ด้วยรหัสใบรับรองหรือ QR บนไฟล์</p>

      {loadError && <div className="mt-6"><Notice tone="error">{loadError}</Notice></div>}
      {message && <div className="mt-6"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {!items && !loadError && <p className="mt-6 text-sm text-ink-soft">กำลังโหลด…</p>}
      {items && items.length === 0 && (
        <div className="mt-6 rounded-xl border border-dashed border-border p-10 text-center">
          <p className="font-semibold">ยังไม่มีใบรับรอง</p>
          <p className="mt-1 text-sm text-ink-soft">ใบรับรองจะปรากฏเมื่อบริษัทประเมินผ่านและออกใบให้หลังฝึกครบเกณฑ์ ดูความคืบหน้าได้ที่ใบสมัครของคุณ</p>
          <Link href="/student/applications" className="mt-3 inline-block text-sm font-medium text-primary hover:underline">ไปที่ใบสมัครของฉัน</Link>
        </div>
      )}
      {items && items.length > 0 && (
        <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map((item) => (
            <li key={item.id} className={`rounded-xl p-6 ${item.status === 'VALID' ? 'bg-tile text-white' : 'bg-surface-muted text-ink'}`}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 [overflow-wrap:anywhere]">
                  <h2 className={`text-2xl font-semibold ${item.status === 'VALID' ? '' : 'line-through'}`}>{item.job_title}</h2>
                  <p className={`text-sm ${item.status === 'VALID' ? 'text-white/75' : 'text-ink-soft'}`}>{item.company_name}</p>
                </div>
                {item.status === 'VALID'
                  ? <StatusBadge tone="success" icon={CircleCheck}>ใช้ได้</StatusBadge>
                  : <StatusBadge tone="danger" icon={CircleX}>ถูกเพิกถอน</StatusBadge>}
              </div>
              <dl className="mt-4 grid grid-cols-2 gap-4 text-sm lg:grid-cols-4">
                <div><dt className="text-xs opacity-75">รหัสใบรับรอง</dt><dd className="mt-0.5 break-all font-medium">{item.certificate_code}</dd></div>
                <div><dt className="text-xs opacity-75">ช่วงฝึกงาน</dt><dd className="mt-0.5 font-medium">{formatDate(item.period.start)} – {formatDate(item.period.end)}</dd></div>
                <div><dt className="text-xs opacity-75">ฝึกจริง</dt><dd className="mt-0.5 font-medium">{item.actual_days} วัน</dd></div>
                <div><dt className="text-xs opacity-75">ออกเมื่อ</dt><dd className="mt-0.5 font-medium">{formatDate(item.issued_at)}</dd></div>
              </dl>
              <div className="mt-5 flex flex-wrap items-center gap-3">
                <CertificateQr code={item.certificate_code} />
                {item.status === 'VALID' ? (
                  <button type="button" disabled={busyId === item.id} onClick={() => void download(item)}
                    className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
                    {busyId === item.id ? 'กำลังเตรียมไฟล์…' : 'ดาวน์โหลด PDF'}
                  </button>
                ) : (
                  <p className="text-sm text-ink-soft">ใบรับรองนี้ถูกเพิกถอนแล้ว ดาวน์โหลดไม่ได้ หากเห็นว่าผิดพลาดกรุณาติดต่อบริษัทหรือผู้ดูแลระบบ</p>
                )}
                <Link href={verificationPath(item.certificate_code)}
                  className={`text-sm hover:underline ${item.status === 'VALID' ? 'text-primary-on-dark' : 'text-primary'}`}>ตรวจสอบใบรับรอง ›</Link>
                <button type="button" onClick={() => void copyVerificationLink(item.certificate_code)}
                  className={`rounded-full border px-4 py-2 text-sm ${item.status === 'VALID' ? 'border-white/25' : 'border-border'}`}>คัดลอกลิงก์ตรวจสอบ</button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {items?.some((item) => item.status === 'VALID') && <Link href="/student/reviews" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">เขียนรีวิวบริษัท ›</Link>}
    </main>
  );
}
