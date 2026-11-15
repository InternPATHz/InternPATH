'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

export default function ResendVerificationPage() {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await apiRequest<void>('/auth/resend-verification', { email: String(form.get('email')).trim() });
      setSent(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ส่งคำขอไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title="ขอลิงก์ยืนยันใหม่" subtitle="หากบัญชียังรอยืนยันอีเมล เราจะส่งลิงก์ใหม่ให้">
    {sent ? <Notice>หากบัญชียังรอยืนยันอีเมล กรุณาตรวจกล่องจดหมาย</Notice> :
      <form onSubmit={submit} className="space-y-4">
        <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>ส่งลิงก์ใหม่</ActionButton>
      </form>}
    <p className="mt-5 text-sm"><Link href="/login" className="text-primary hover:underline">กลับไปเข้าสู่ระบบ</Link></p>
  </AuthShell>;
}
