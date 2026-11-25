'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { CircleCheck, KeyRound } from 'lucide-react';
import { ActionButton, AuthShell, NewPasswordFields, Notice } from '@/auth/ui';
import { ApiError, apiRequest } from '@/lib/api';

export default function ResetPasswordPage() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || busy) return;
    const form = new FormData(event.currentTarget);
    const password = String(form.get('new_password'));
    if (password !== form.get('confirm_password')) { setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }
    setBusy(true);
    setError('');
    try {
      await apiRequest<void>('/auth/password/reset', { token, new_password: password });
      setDone(true);
    } catch (cause) { setInvalid(cause instanceof ApiError && cause.code === 'INVALID_TOKEN'); setError(cause instanceof Error ? cause.message : 'ตั้งรหัสผ่านใหม่ไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title={done ? 'ตั้งรหัสผ่านใหม่แล้ว' : invalid || token === '' ? 'ลิงก์นี้ใช้ไม่ได้แล้ว' : 'ตั้งรหัสผ่านใหม่'} subtitle={done ? undefined : 'ลิงก์ใช้ได้ครั้งเดียวภายใน 30 นาที'} icon={done ? <CircleCheck size={34} /> : <KeyRound size={34} />}>
    {done ? <Notice>ตั้งรหัสผ่านใหม่สำเร็จแล้ว กรุณาเข้าสู่ระบบ</Notice> : token === null ? <p role="status">กำลังอ่านลิงก์…</p> : !token || invalid ?
      <Notice error>ลิงก์ตั้งรหัสผ่านใช้ไม่ได้ กรุณาขอลิงก์รีเซ็ตใหม่</Notice> :
      <form onSubmit={submit} className="space-y-4">
        <NewPasswordFields name="new_password" />
        {error && <Notice error focus>{error}</Notice>}
        <ActionButton busy={busy}>ตั้งรหัสผ่านใหม่</ActionButton>
      </form>}
    <div className="mt-5 flex flex-wrap gap-4 text-sm">
      <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link>
      {!done && <Link href="/forgot-password" className="text-primary hover:underline">ขอลิงก์รีเซ็ตใหม่</Link>}
    </div>
  </AuthShell>;
}
