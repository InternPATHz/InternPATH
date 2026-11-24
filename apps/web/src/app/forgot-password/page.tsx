'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { KeyRound, Mail } from 'lucide-react';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

// Identity limits repeated requests for an account to at least 60 seconds.
const RESEND_DELAY_SECONDS = 60;

export default function ForgotPasswordPage() {
  const [busy, setBusy] = useState(false);
  const [sentEmail, setSentEmail] = useState('');
  const [resendAt, setResendAt] = useState(0);
  const [secondsLeft, setSecondsLeft] = useState(0);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!resendAt) return;
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((resendAt - Date.now()) / 1000));
      setSecondsLeft(next);
      if (!next) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [resendAt]);

  async function send(email: string) {
    if (busy || Date.now() < resendAt) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest<void>('/auth/password/forgot', { email });
      setSentEmail(email);
      setResendAt(Date.now() + RESEND_DELAY_SECONDS * 1000);
      setSecondsLeft(RESEND_DELAY_SECONDS);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ส่งคำขอไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void send(String(new FormData(event.currentTarget).get('email')).trim());
  }

  return (
    <AuthShell title={sentEmail ? 'ตรวจอีเมลของคุณ' : 'ลืมรหัสผ่าน?'} icon={sentEmail ? <Mail size={34} /> : <KeyRound size={34} />}
      subtitle={sentEmail ? 'หากอีเมลนี้มีบัญชีอยู่ คุณจะได้รับลิงก์ตั้งรหัสผ่านใหม่ที่ใช้ได้ครั้งเดียวภายใน 30 นาที'
        : 'หากอีเมลนี้มีบัญชีอยู่ เราจะส่งลิงก์รีเซ็ตรหัสผ่านให้'}>
      {sentEmail ? (
        <div className="space-y-3 text-center">
          {error && <Notice error>{error}</Notice>}
          <button type="button" disabled={busy || secondsLeft > 0} onClick={() => void send(sentEmail)}
            className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-primary disabled:text-ink-soft">
            {secondsLeft > 0 ? `ส่งอีกครั้งได้ใน ${secondsLeft} วินาที` : busy ? 'กำลังส่ง…' : 'ส่งอีกครั้ง'}
          </button>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          <Field label="อีเมล" name="email" type="email" autoComplete="email" required />
          {error && <Notice error>{error}</Notice>}
          <ActionButton busy={busy}>ส่งลิงก์รีเซ็ต</ActionButton>
        </form>
      )}
      <p className="mt-5 text-center text-sm"><Link href="/login" className="text-primary hover:underline">กลับไปเข้าสู่ระบบ</Link></p>
    </AuthShell>
  );
}
