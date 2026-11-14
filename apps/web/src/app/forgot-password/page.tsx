'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest<void>('/auth/password/forgot', { email: String(form.get('email')).trim() });
      setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ส่งคำขอไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title="ลืมรหัสผ่าน" subtitle="หากอีเมลนี้มีบัญชีอยู่ เราจะส่งลิงก์รีเซ็ตรหัสผ่านให้">
    {sent ? <Notice>หากอีเมลนี้มีบัญชีอยู่ กรุณาตรวจกล่องจดหมายเพื่อตั้งรหัสผ่านใหม่</Notice> :
      <form onSubmit={submit} className="space-y-4">
        <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>ส่งลิงก์รีเซ็ต</ActionButton>
      </form>}
    <p className="mt-5 text-sm"><Link href="/login" className="text-primary hover:underline">กลับไปเข้าสู่ระบบ</Link></p>
  </AuthShell>;
}
