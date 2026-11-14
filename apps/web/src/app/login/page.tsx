'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError('');
    const form = new FormData(event.currentTarget);
    try {
      await login(String(form.get('email')), String(form.get('password')));
      router.replace('/account');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'เข้าสู่ระบบไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  return <AuthShell title="เข้าสู่ระบบ" subtitle="ใช้อีเมลที่สมัครไว้กับ InternPath">
    <form onSubmit={submit} className="space-y-4">
      <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
      <Field label="รหัสผ่าน" name="password" type="password" autoComplete="current-password" required />
      {error && <Notice error>{error}</Notice>}
      <ActionButton busy={busy}>เข้าสู่ระบบ</ActionButton>
    </form>
    <div className="mt-5 flex flex-wrap justify-between gap-2 text-sm">
      <Link href="/forgot-password" className="text-primary hover:underline">ลืมรหัสผ่าน?</Link>
      <Link href="/register" className="text-primary hover:underline">ยังไม่มีบัญชี? สมัครสมาชิก</Link>
    </div>
  </AuthShell>;
}
