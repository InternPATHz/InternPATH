'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { LockKeyhole, LockKeyholeOpen, Mail } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { ActionButton, AuthShell, Field, Notice, PasswordField } from '@/auth/ui';
import { ROLE_HOME } from '@/components/layout/site-nav';
import { ApiError, apiRequest } from '@/lib/api';

export default function UnlockLoginPage() {
  const router = useRouter();
  const { login } = useAuth();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    setBusy(true);
    setError('');
    try {
      if (token) {
        const user = await login(email, String(form.get('password')), token);
        router.replace(ROLE_HOME[user.role] ?? '/account');
      } else {
        await apiRequest<void>('/auth/login/unlock/request', { email });
        setSent(true);
      }
    } catch (cause) { setError(cause instanceof ApiError && cause.code === 'INVALID_CREDENTIALS' ? 'ตรวจอีเมล รหัสผ่าน และเปิดลิงก์ปลดล็อกล่าสุดอีกครั้ง' : cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title={sent ? 'ตรวจอีเมลของคุณ' : token ? 'เข้าสู่ระบบเพื่อปลดล็อก' : 'บัญชีถูกล็อกชั่วคราว'}
    icon={sent ? <Mail size={34} /> : token ? <LockKeyholeOpen size={34} /> : <LockKeyhole size={34} />} subtitle={sent ? undefined : token
    ? 'ลิงก์นี้ใช้ได้ครั้งเดียว กรุณาใส่อีเมลและรหัสผ่านของบัญชี'
    : 'หากบัญชีถูกล็อก เราจะส่งลิงก์เข้าสู่ระบบไปยังอีเมลที่สมัครไว้'}>
    {sent ? <Notice>หากบัญชีนี้ถูกล็อก กรุณาตรวจอีเมลเพื่อเปิดลิงก์เข้าสู่ระบบภายใน 15 นาที</Notice> :
      <form onSubmit={submit} className="space-y-4">
        <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
        {token && <PasswordField label="รหัสผ่าน" name="password" autoComplete="current-password" required />}
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>{token ? 'เข้าสู่ระบบ' : 'ส่งลิงก์'}</ActionButton>
      </form>}
    <div className="mt-5 flex flex-wrap justify-center gap-4 text-sm">
      <Link href="/login" className="text-primary hover:underline">กลับไปเข้าสู่ระบบ</Link>
      {token && <a href="/unlock-login" className="text-primary">ขอลิงก์ปลดล็อก</a>}
      <Link href="/forgot-password" className="text-primary hover:underline">ตั้งรหัสผ่านใหม่</Link>
    </div>
  </AuthShell>;
}
