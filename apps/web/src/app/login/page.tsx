'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { ActionButton, AuthShell, Field, Notice, PasswordField } from '@/auth/ui';
import { pathAllowedFor, ROLE_HOME } from '@/components/layout/site-nav';
import { ApiError } from '@/lib/api';

const recoveryLinks = new Map([
  ['EMAIL_NOT_VERIFIED', { href: '/resend-verification', label: 'ขออีเมลยืนยันใหม่' }],
  ['ACCOUNT_LOCKED', { href: '/unlock-login', label: 'ขอลิงก์ปลดล็อกบัญชี' }],
]);

/**
 * คืนเส้นทางภายในเว็บจาก `?next=` หรือ null • เบราว์เซอร์อ่าน `\` เป็น `/` ⇒ `/\evil.com` = `//evil.com`
 * จึงแปลงเป็น URL เทียบ origin ปัจจุบันแทนการเช็กแค่ตัวอักษรขึ้นต้น
 */
function safeNextPath(next: string | null): string | null {
  if (!next || !next.startsWith('/') || next.startsWith('//') || /[\\\s]/.test(next)) return null;
  try {
    const url = new URL(next, window.location.origin);
    return url.origin === window.location.origin ? url.pathname + url.search + url.hash : null;
  } catch { return null; }
}

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
      // `next` ใช้ได้เฉพาะเส้นทางภายในเว็บ กัน open redirect • ไม่มี/ไม่ปลอดภัย ⇒ หน้าแรกของบทบาท
      // และต้องเป็นหน้าของบทบาทนี้ — `next` อาจค้างจากผู้ใช้คนก่อน (เช่น HR ออกจาก /hr/jobs แล้ว Admin ล็อกอินต่อ)
      const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
      router.replace(next && pathAllowedFor(next, user.role) ? next : ROLE_HOME[user.role] ?? '/account');
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
      <Link href="/unlock-login" className={recoveryLink?.href === '/unlock-login' ? 'text-primary lg:hidden' : 'text-primary hover:underline'}>บัญชีถูกล็อก?</Link>
      <Link href="/forgot-password" className="text-primary hover:underline">ลืมรหัสผ่าน?</Link>
    </div>
    <p className="mt-6 border-t border-border pt-5 text-center text-sm text-ink-soft">
      สมัครบัญชีอาจารย์หรือบริษัท{' '}
      <Link href="/register" className="font-semibold text-primary hover:underline">สมัครสมาชิก</Link>
    </p>
    <p className="mt-2 text-center text-sm text-ink-soft">นักศึกษาเปิดใช้งานบัญชีจากอีเมลคำเชิญของอาจารย์</p>
  </AuthShell>;
}
