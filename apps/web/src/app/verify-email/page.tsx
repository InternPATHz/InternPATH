'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { AuthShell, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

export default function VerifyEmailPage() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
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
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ยืนยันอีเมลไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return <AuthShell title="ยืนยันอีเมล" subtitle="ลิงก์ยืนยันอีเมลใช้ได้ครั้งเดียวภายใน 24 ชั่วโมง">
    <div className="space-y-4">
      {verified ? <Notice>ยืนยันอีเมลสำเร็จแล้ว หากสมัครเป็นอาจารย์ โปรดรอ Admin อนุมัติบัญชี</Notice> : <>
        {!token && <Notice error>ไม่พบ token ในลิงก์ กรุณาเปิดลิงก์จากอีเมลอีกครั้ง</Notice>}
        {error && <Notice error>{error}</Notice>}
        <button type="button" disabled={!token || busy} onClick={verify}
          className="w-full rounded-full bg-primary px-4 py-3 font-semibold text-white hover:bg-primary-hover disabled:opacity-50">
          {busy ? 'กำลังยืนยัน…' : 'ยืนยันอีเมล'}
        </button>
      </>}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link>
        <Link href="/resend-verification" className="text-primary hover:underline">ขอลิงก์ใหม่</Link>
      </div>
    </div>
  </AuthShell>;
}
