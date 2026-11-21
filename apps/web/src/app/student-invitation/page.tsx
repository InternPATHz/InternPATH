'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import type { AcceptStudentInvitationRequest } from '@internpath/contracts';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

/**
 * ลิงก์ในอีเมลคำเชิญที่อาจารย์สร้างบัญชีให้ (Identity ส่ง `/student-invitation?token=`)
 * นักศึกษาตั้งรหัสผ่านและยอมรับนโยบายความเป็นส่วนตัว → บัญชีใช้งานได้ทันที — token ใช้ได้ครั้งเดียว อายุ 7 วัน
 */
export default function StudentInvitationPage() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== form.get('confirm_password')) { setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }
    setBusy(true);
    setError('');
    try {
      const body: AcceptStudentInvitationRequest = { token, password, accept_privacy: true };
      await apiRequest<void>('/auth/student-invitations/accept', body);
      setDone(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'ตั้งรหัสผ่านไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  return (
    <AuthShell title="เริ่มใช้งานบัญชีนักศึกษา" subtitle="อาจารย์ที่ปรึกษาสร้างบัญชีให้คุณแล้ว ตั้งรหัสผ่านเพื่อเริ่มใช้งาน ลิงก์ใช้ได้ครั้งเดียวภายใน 7 วัน">
      {done ? (
        <div className="space-y-4">
          <Notice>ตั้งรหัสผ่านสำเร็จแล้ว เข้าสู่ระบบด้วยอีเมลสถาบันของคุณได้เลย</Notice>
          <Link href="/login" className="text-sm text-primary hover:underline">เข้าสู่ระบบ</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!token && <Notice error>ไม่พบ token ในลิงก์ กรุณาเปิดลิงก์จากอีเมลคำเชิญอีกครั้ง</Notice>}
          {error && <Notice error>{error}</Notice>}
          <Field label="รหัสผ่าน (อย่างน้อย 12 ตัวอักษร)" name="password" type="password" minLength={12} autoComplete="new-password" required />
          <Field label="ยืนยันรหัสผ่าน" name="confirm_password" type="password" minLength={12} autoComplete="new-password" required />
          <label className="flex gap-2 text-sm text-ink-soft">
            <input type="checkbox" name="accept_privacy" required className="mt-1 accent-primary" />
            <span>ยอมรับ<Link href="/privacy" target="_blank" rel="noopener" className="text-primary hover:underline">นโยบายความเป็นส่วนตัว</Link>และการเก็บข้อมูลส่วนบุคคล<span aria-hidden="true" className="text-danger"> *</span></span>
          </label>
          <ActionButton busy={busy}>ตั้งรหัสผ่านและเริ่มใช้งาน</ActionButton>
          <p className="text-xs text-ink-soft">ลิงก์หมดอายุหรือใช้ไม่ได้ ติดต่ออาจารย์ที่ปรึกษาให้ส่งคำเชิญใหม่</p>
        </form>
      )}
    </AuthShell>
  );
}
