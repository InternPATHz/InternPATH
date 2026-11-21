'use client';

import { Suspense } from 'react';
import { CertificateVerify } from '@/components/certificates/certificate-verify';

// ไม่ต้องล็อกอิน — QR ในใบรับรองชี้มาที่ `/public/certificates?code=` (api-contract §7.5) ใช้ query แทนเส้นทางไดนามิกเพื่อส่งออก static ได้
export default function PublicCertificatePage() {
  return (
    <Suspense fallback={<main className="mx-auto max-w-2xl px-4 py-12 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>}>
      <CertificateVerify />
    </Suspense>
  );
}
