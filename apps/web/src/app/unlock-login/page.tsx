'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { ROLE_HOME } from '@/components/layout/site-nav';
import { apiRequest } from '@/lib/api';

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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title="เข้าสู่ระบบเมื่อบัญชีถูกล็อก" subtitle={token
    ? 'ลิงก์นี้ใช้ได้ครั้งเดียว กรุณาใส่อีเมลและรหัสผ่านของบัญชี'
    : 'หากบัญชีถูกล็อก เราจะส่งลิงก์เข้าสู่ระบบไปยังอีเมลที่สมัครไว้'}>
    {sent ? <Notice>หากบัญชีนี้ถูกล็อก กรุณาตรวจอีเมลเพื่อเปิดลิงก์เข้าสู่ระบบ</Notice> :
      <form onSubmit={submit} className="space-y-4">
        <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
        {token && <Field label="รหัสผ่าน" name="password" type="password" autoComplete="current-password" required />}
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>{token ? 'เข้าสู่ระบบ' : 'ส่งลิงก์'}</ActionButton>
      </form>}
    <p className="mt-5 text-sm"><Link href="/login" className="text-primary hover:underline">กลับไปเข้าสู่ระบบ</Link></p>
  </AuthShell>;
}
