'use client';

import type { CertificateItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { IdActionForm } from '@/components/admin/lifecycle/id-action-form';
import { ApiError } from '@/lib/api';

function failure(cause: unknown): Error {
  if (!(cause instanceof ApiError)) return new Error('เพิกถอนไม่สำเร็จ กรุณาลองใหม่');
  if (cause.status === 404) return new Error('ไม่พบใบรับรองนี้');
  if (cause.issues.includes('ALREADY_REVOKED')) return new Error('ใบรับรองนี้ถูกเพิกถอนไปแล้ว');
  if (cause.code === 'REASON_REQUIRED') return new Error('กรุณากรอกเหตุผล');
  return new Error(cause.message);
}

/**
 * Admin เพิกถอนใบรับรองใดก็ได้ (README §5.4/§5.10) — `POST /admin/lifecycle/certificates/{id}/actions/revoke` `{reason}`
 * หลังเพิกถอน หน้าตรวจสอบสาธารณะ `/public/certificates?code=` จะแสดง "ถูกเพิกถอน"
 */
export function CertificateRevoke() {
  const { request } = useAuth();

  async function revoke(id: string, reason: string): Promise<string> {
    try {
      const cert = await request<CertificateItem>(`/admin/lifecycle/certificates/${encodeURIComponent(id)}/actions/revoke`, { method: 'POST', body: { reason } });
      return `เพิกถอนใบรับรอง ${cert.certificate_code} (${cert.company_name}) แล้ว`;
    } catch (cause) {
      throw failure(cause);
    }
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold">ใบรับรอง</h1>
      <p className="mt-1 text-sm text-ink-soft">
        เพิกถอนใบรับรองที่ออกผิดหรือพบการทุจริต หลังเพิกถอน หน้าตรวจสอบใบรับรองสาธารณะจะแสดงว่า &quot;ถูกเพิกถอน&quot; ทุกการกระทำบันทึก Audit log และย้อนกลับไม่ได้
      </p>
      <div className="mt-5 max-w-xl">
        <IdActionForm
          title="เพิกถอนใบรับรอง"
          description="ระบุรหัสใบรับรอง (UUID ภายในระบบ ไม่ใช่รหัสบนใบรับรองแบบ IP-xxxx)"
          idLabel="รหัสใบรับรอง"
          reasonLabel="เหตุผลที่เพิกถอน"
          submitLabel="เพิกถอนใบรับรอง"
          confirmText={(id) => `เพิกถอนใบรับรอง ${id}? ย้อนกลับไม่ได้`}
          onSubmit={revoke}
        />
      </div>
    </div>
  );
}
