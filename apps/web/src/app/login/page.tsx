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
    <div className="mt-4 flex justify-between gap-4 text-sm">
      <Link href="/unlock-login" className="text-ink-soft hover:text-primary hover:underline">บัญชีถูกล็อก?</Link>
      <Link href="/forgot-password" className="text-ink-soft hover:text-primary hover:underline">ลืมรหัสผ่าน?</Link>
    </div>
    <p className="mt-6 border-t border-border pt-5 text-center text-sm text-ink-soft">
      ยังไม่มีบัญชี?{' '}
      <Link href="/register" className="font-semibold text-primary hover:underline">สมัครสมาชิก</Link>
    </p>
  </AuthShell>;
}
