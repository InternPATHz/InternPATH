'use client';

import Link from 'next/link';
import { useState } from 'react';
import { allPages } from '@/lib/list';
import { useSearchParams } from 'next/navigation';
import type { AdminApplicationActionResponse, AdminUserListItem, Paginated, ReapplyUnlockResponse } from '@internpath/contracts';
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
 * `?terminate=<application_id>` (ลิงก์จากหน้ารายงานปัญหา) ⇒ เติมรหัสในฟอร์มยุติไว้ให้ — Admin ยังต้องใส่เหตุผลและยืนยันเอง
 */
export function ApplicationActions({ mode, onChanged }: { mode: 'unlock' | 'terminate'; onChanged?: () => void }) {
  const { request } = useAuth();
  const terminateId = useSearchParams().get('terminate') ?? '';

  const [term, setTerm] = useState('');
  const [matches, setMatches] = useState<AdminUserListItem[] | null>(null);
  const [chosen, setChosen] = useState<AdminUserListItem | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  async function search(event: React.FormEvent) {
    event.preventDefault();
    setSearching(true); setError(''); setChosen(null); setMatches(null);
    try {
      const students = await allPages((page) => request<Paginated<AdminUserListItem>>(`/admin/users?${new URLSearchParams({role:'STUDENT', q:term.trim(), page:String(page), page_size:'100'})}`));
      setMatches(students);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ค้นหานักศึกษาไม่สำเร็จ'); }
    finally { setSearching(false); }
  }

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
    <section id="application-actions" aria-labelledby="application-actions-title" className="mt-10 scroll-mt-6">
      <h2 id="application-actions-title" className="text-xl font-semibold">{mode === 'terminate' ? 'ยุติการฝึกงาน' : 'ปลดล็อกสมัครซ้ำ'}</h2>
      <p className="mt-1 text-sm text-ink-soft">ใช้เมื่อพบปัญหาร้ายแรง เช่น บริษัทหลอกลวง ทุกการกระทำบันทึก Audit log และย้อนกลับไม่ได้</p>
      <div className="mt-4 grid max-w-2xl gap-4">
        {mode === 'unlock' && <div><form onSubmit={search} className="flex items-end gap-2"><label className="grow text-sm">ชื่อ อีเมล หรือรหัสนักศึกษา<input required disabled={searching} value={term} onChange={(e) => { setTerm(e.target.value); setChosen(null); setMatches(null); }} className="mt-1 w-full rounded-lg border border-border p-2" /></label><button disabled={searching || !term.trim()} className="rounded-lg border border-border p-2">ค้นหา</button></form>
          {error && <p role="alert">{error}</p>}{matches && <ul className="mt-2 divide-y divide-border">{!matches.length && <li>ไม่พบนักศึกษา</li>}{matches.map((student) => <li key={student.id}><button className="w-full rounded-lg p-3 text-left text-sm aria-pressed:bg-primary-soft" aria-pressed={chosen?.id === student.id} onClick={() => setChosen(student)}>{student.full_name} · {student.student_code} · {student.email}</button></li>)}</ul>}</div>}
        {mode === 'terminate' && !terminateId && <Link className="text-primary" href="/admin/problem-reports">เลือกรายงานปัญหาเพื่อยุติการฝึกงานของใบสมัครนั้น ›</Link>}
        {mode === 'terminate' && terminateId &&
        <IdActionForm
          title="ยุติการฝึกงาน"
          description="เปลี่ยนใบสมัครที่กำลังฝึกงานเป็น &quot;ยุติกลางคัน&quot; โดยผู้ดูแล วันสิ้นสุดจริงเป็นวันนี้"
          idLabel="รหัสใบสมัคร"
          reasonLabel="เหตุผลที่ยุติ"
          submitLabel="ยุติการฝึกงาน"
          confirmText={(id) => `ยุติการฝึกงานของใบสมัคร ${id}? ย้อนกลับไม่ได้`}
          initialId={terminateId}
          key={terminateId}
          onSubmit={terminate}
        />}
        {mode === 'unlock' && chosen &&
        <IdActionForm
          title="ปลดล็อกการสมัครซ้ำ"
          description="นักศึกษาที่ผ่านรายวิชาแล้วถูกบล็อกไม่ให้สมัครใหม่ ปลดล็อกให้สมัครได้อีก 1 ใบ"
          idLabel="รหัสผู้ใช้นักศึกษา"
          reasonLabel="เหตุผลที่ปลดล็อก"
          submitLabel="ปลดล็อก"
          confirmText={() => `ปลดล็อกให้ ${chosen.full_name} (${chosen.student_code || chosen.email}) สมัครได้อีก 1 ใบ?`}
          initialId={chosen.id} key={chosen.id} targetLabel={`${chosen.full_name} · ${chosen.student_code} · ${chosen.email}`}
          onSubmit={unlock}
        />}
      </div>
    </section>
  );
}
