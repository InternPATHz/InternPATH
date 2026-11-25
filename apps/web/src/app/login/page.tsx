'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { ActionButton, AuthShell, Field, Notice, PasswordField } from '@/auth/ui';
import { ROLE_HOME } from '@/components/layout/site-nav';
import { ApiError } from '@/lib/api';

const recoveryLinks = new Map([
  ['EMAIL_NOT_VERIFIED', { href: '/resend-verification', label: 'ขออีเมลยืนยันใหม่' }],
  ['ACCOUNT_LOCKED', { href: '/unlock-login', label: 'ขอลิงก์ปลดล็อกบัญชี' }],
]);

export default function LoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const recoveryLink = error instanceof ApiError ? recoveryLinks.get(error.code) : undefined;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    const form = new FormData(event.currentTarget);
    try {
      const user = await login(String(form.get('email')), String(form.get('password')));
      // `next` ใช้ได้เฉพาะเส้นทางภายในเว็บ (ขึ้นต้น / และไม่ใช่ //) กัน open redirect • ไม่มี ⇒ หน้าแรกของบทบาท
      const next = new URLSearchParams(window.location.search).get('next');
      router.replace(next && next.startsWith('/') && !next.startsWith('//') ? next : ROLE_HOME[user.role] ?? '/account');
    } catch (cause) {
      setError(cause instanceof Error ? cause : new Error('เข้าสู่ระบบไม่สำเร็จ'));
    } finally { setBusy(false); }
  }

  return <AuthShell title="เข้าสู่ระบบ InternPath" subtitle="ใช้อีเมลที่สมัครไว้กับ InternPath">
    <form onSubmit={submit} className="space-y-4">
      <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
      <PasswordField label="รหัสผ่าน" name="password" autoComplete="current-password" required />
      {error && (
        <Notice error>
          <span className="lg:[overflow-wrap:anywhere]">{error.message}</span>
          {recoveryLink && (
            <Link href={recoveryLink.href} className="hidden font-medium text-primary underline underline-offset-2 lg:inline">
              {' '}{recoveryLink.label}
            </Link>
          )}
        </Notice>
      )}
      <ActionButton busy={busy}>เข้าสู่ระบบ</ActionButton>
    </form>
    <div className="mt-6 flex flex-wrap justify-center gap-4 text-sm">
      <Link href="/unlock-login" className="text-primary hover:underline">บัญชีถูกล็อก?</Link>
      <Link href="/forgot-password" className="text-primary hover:underline">ลืมรหัสผ่าน?</Link>
    </div>
    <p className="mt-6 border-t border-border pt-5 text-center text-sm text-ink-soft">
      ยังไม่มีบัญชี?{' '}
      <Link href="/register" className="font-semibold text-primary hover:underline">สมัครสมาชิก</Link>
    </p>
  </AuthShell>;
}
