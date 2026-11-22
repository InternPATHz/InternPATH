'use client';

import type { AdminApplicationActionResponse, ReapplyUnlockResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { IdActionForm } from '@/components/admin/lifecycle/id-action-form';
import { ApiError } from '@/lib/api';

function terminateFailure(cause: unknown): Error {
  if (!(cause instanceof ApiError)) return new Error('ยุติการฝึกงานไม่สำเร็จ กรุณาลองใหม่');
  if (cause.status === 404) return new Error('ไม่พบใบสมัครนี้');
  if (cause.code === 'REASON_REQUIRED') return new Error('กรุณากรอกเหตุผล');
  if (cause.code === 'STATE_CONFLICT') return new Error('ยุติได้เฉพาะใบสมัครที่กำลังฝึกงาน (IN_PROGRESS)');
  return new Error(cause.message);
}

function unlockFailure(cause: unknown): Error {
  if (!(cause instanceof ApiError)) return new Error('ปลดล็อกไม่สำเร็จ กรุณาลองใหม่');
  if (cause.issues.includes('REAPPLY_ALREADY_UNLOCKED')) return new Error('นักศึกษาคนนี้มีสิทธิ์สมัครซ้ำที่ยังไม่ใช้อยู่แล้ว');
  if (cause.issues.includes('REAPPLY_NOT_BLOCKED')) return new Error('นักศึกษาคนนี้ไม่ได้ถูกบล็อกการสมัครซ้ำ (ยังไม่มีผลผ่านรายวิชา หรือไม่พบนักศึกษา)');
  if (cause.code === 'REASON_REQUIRED') return new Error('กรุณากรอกเหตุผล');
  return new Error(cause.message);
}

/**
 * Action ของ Admin กับใบสมัคร/นักศึกษา (README §5.2.2, §5.10; UAT-38/40) — รับรหัสโดยตรงเพราะ API ไม่มีรายการให้เลือก
 * - `POST /admin/lifecycle/applications/{id}/actions/terminate` `{reason}` — เฉพาะ `IN_PROGRESS`
 * - `POST /admin/lifecycle/students/{user_id}/reapply-unlock` `{reason}` — ให้สิทธิ์สมัครได้อีก 1 ใบ
 */
export function ApplicationActions({ onChanged }: { onChanged?: () => void }) {
  const { request } = useAuth();

  async function terminate(id: string, reason: string): Promise<string> {
    try {
      const app = await request<AdminApplicationActionResponse>(`/admin/lifecycle/applications/${encodeURIComponent(id)}/actions/terminate`, { method: 'POST', body: { reason } });
      onChanged?.();
      return `ยุติการฝึกงาน ${app.job_title || 'ไม่ทราบตำแหน่ง'} (${app.company_name || 'ไม่ทราบชื่อบริษัท'}) แล้ว`;
    } catch (cause) {
      throw terminateFailure(cause);
    }
  }

  async function unlock(id: string, reason: string): Promise<string> {
    try {
      await request<ReapplyUnlockResponse>(`/admin/lifecycle/students/${encodeURIComponent(id)}/reapply-unlock`, { method: 'POST', body: { reason } });
      return 'ปลดล็อกแล้ว นักศึกษาสมัครงานได้อีก 1 ใบ';
    } catch (cause) {
      throw unlockFailure(cause);
    }
  }

  return (
    <section aria-labelledby="application-actions-title" className="mt-10">
      <h2 id="application-actions-title" className="text-xl font-semibold">ดำเนินการด้วยรหัส</h2>
      <p className="mt-1 text-sm text-ink-soft">ใช้เมื่อพบปัญหาร้ายแรง เช่น บริษัทหลอกลวง ทุกการกระทำบันทึก Audit log และย้อนกลับไม่ได้</p>
      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <IdActionForm
          title="ยุติการฝึกงาน"
          description="เปลี่ยนใบสมัครที่กำลังฝึกงานเป็น &quot;ยุติกลางคัน&quot; โดยผู้ดูแล วันสิ้นสุดจริงเป็นวันนี้"
          idLabel="รหัสใบสมัคร"
          reasonLabel="เหตุผลที่ยุติ"
          submitLabel="ยุติการฝึกงาน"
          confirmText={(id) => `ยุติการฝึกงานของใบสมัคร ${id}? ย้อนกลับไม่ได้`}
          onSubmit={terminate}
        />
        <IdActionForm
          title="ปลดล็อกการสมัครซ้ำ"
          description="นักศึกษาที่ผ่านรายวิชาแล้วถูกบล็อกไม่ให้สมัครใหม่ ปลดล็อกให้สมัครได้อีก 1 ใบ"
          idLabel="รหัสผู้ใช้นักศึกษา"
          reasonLabel="เหตุผลที่ปลดล็อก"
          submitLabel="ปลดล็อก"
          confirmText={(id) => `ปลดล็อกให้นักศึกษา ${id} สมัครได้อีก 1 ใบ?`}
          onSubmit={unlock}
        />
      </div>
    </section>
  );
}
