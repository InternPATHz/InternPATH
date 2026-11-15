'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

export default function ResetPasswordPage() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('new_password'));
    if (password !== form.get('confirm_password')) { setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }
    setBusy(true);
    setError('');
    try {
      await apiRequest<void>('/auth/password/reset', { token, new_password: password });
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ตั้งรหัสผ่านใหม่ไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title="ตั้งรหัสผ่านใหม่" subtitle="ลิงก์ใช้ได้ครั้งเดียวภายใน 30 นาที">
    {done ? <Notice>ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบ</Notice> : !token ?
      <Notice error>ไม่พบ token ในลิงก์ กรุณาขอลิงก์รีเซ็ตใหม่</Notice> :
      <form onSubmit={submit} className="space-y-4">
        <Field label="รหัสผ่านใหม่ (อย่างน้อย 12 ตัวอักษร)" name="new_password" type="password" minLength={12} autoComplete="new-password" required />
        <Field label="ยืนยันรหัสผ่านใหม่" name="confirm_password" type="password" minLength={12} autoComplete="new-password" required />
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>ตั้งรหัสผ่านใหม่</ActionButton>
      </form>}
    <div className="mt-5 flex flex-wrap gap-4 text-sm">
      <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link>
      <Link href="/forgot-password" className="text-primary hover:underline">ขอลิงก์รีเซ็ตใหม่</Link>
    </div>
  </AuthShell>;
}
