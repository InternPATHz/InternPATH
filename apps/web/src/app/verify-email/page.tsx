'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { CircleAlert, CircleCheck, Mail } from 'lucide-react';
import { AuthShell, Notice } from '@/auth/ui';
import { ApiError, apiRequest } from '@/lib/api';

export default function VerifyEmailPage() {
  const [token, setToken] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<'invalid' | 'changed' | null>(null);
  const [verified, setVerified] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function verify() {
    if (!token || busy) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest<void>('/auth/verify-email', { token });
      setVerified(true);
    } catch (cause) {
      if (cause instanceof ApiError && cause.code === 'STATE_CONFLICT') {
        setOutcome('changed');
        setError('สถานะบัญชีเปลี่ยนแล้ว ลองเข้าสู่ระบบ หากบัญชียังรอยืนยันอีเมล คุณสามารถขอลิงก์ใหม่ได้');
      } else {
        if (cause instanceof ApiError && cause.code === 'INVALID_TOKEN') setOutcome('invalid');
        setError(cause instanceof Error ? cause.message : 'ยืนยันอีเมลไม่สำเร็จ');
      }
    }
    finally { setBusy(false); }
  }

  return <AuthShell title={verified ? 'ยืนยันอีเมลแล้ว' : 'ยืนยันอีเมลของคุณ'} subtitle={verified ? undefined : 'ลิงก์ยืนยันอีเมลใช้ได้ครั้งเดียวภายใน 24 ชั่วโมง'} icon={verified ? <CircleCheck size={34} /> : error ? <CircleAlert size={34} /> : <Mail size={34} />}>
    <div className="space-y-4">
      {verified ? <>
        <p className="rounded-lg bg-surface-muted p-4 text-sm text-ink-soft">หากสมัครเป็นอาจารย์ โปรดรอผู้ดูแลระบบอนุมัติบัญชี</p>
        <Link href="/login" className="block rounded-full bg-primary px-4 py-3 text-center font-semibold text-white hover:bg-primary-hover">เข้าสู่ระบบ</Link>
      </> : <>
        {token === '' && <Notice error>ลิงก์ยืนยันอีเมลไม่ครบ กรุณาขอลิงก์ใหม่</Notice>}
        {error && <Notice error focus>{error}</Notice>}
        {token && !outcome && <button type="button" disabled={busy} onClick={verify}
          className="w-full rounded-full bg-primary px-4 py-3 font-semibold text-white hover:bg-primary-hover disabled:opacity-50">
          {busy ? 'กำลังยืนยัน…' : 'ยืนยันอีเมล'}
        </button>}
      </>}
      {!verified && <div className="flex flex-wrap justify-center gap-4 text-sm">
        <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link>
        <Link href="/resend-verification" className="text-primary hover:underline">ขอลิงก์ใหม่</Link>
      </div>}
    </div>
  </AuthShell>;
}
