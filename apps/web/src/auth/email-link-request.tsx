'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { ActionButton, AuthShell, Field, Notice } from './ui';
import { ApiError, apiRequest } from '@/lib/api';

export function EmailLinkRequest({ verification = false }: { verification?: boolean }) {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState('');
  const [until, setUntil] = useState<Record<string, number>>({});
  const [now, setNow] = useState(Date.now);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const address = (sent || email).trim();
  const key = address.toLowerCase();
  const remaining = Math.max(0, Math.ceil(((until[key] ?? 0) - now) / 1000));
  useEffect(() => {
    if (!remaining) return;
    const timer = window.setTimeout(() => setNow(Date.now()), 1000);
    return () => window.clearTimeout(timer);
  }, [remaining, key]);
  async function send() {
    if (busy || !address || Date.now() < (until[key] ?? 0)) return;
    setBusy(true);
    setError('');
    try {
      await apiRequest<void>(verification ? '/auth/resend-verification' : '/auth/password/forgot', {
        email: address,
      });
      const time = Date.now();
      setNow(time);
      setUntil((prev) => ({ ...prev, [key]: time + 60000 }));
      setSent(address);
    } catch (cause) {
      setError(
        cause instanceof ApiError && cause.status === 429
          ? 'ส่งคำขอบ่อยเกินไป กรุณารอสักครู่แล้วลองใหม่'
          : cause instanceof Error
            ? cause.message
            : 'ส่งคำขอไม่สำเร็จ',
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthShell
      title={sent ? 'ตรวจอีเมลของคุณ' : verification ? 'ขอลิงก์ยืนยันใหม่' : 'ลืมรหัสผ่าน?'}
      icon={<Mail size={34} />}
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        className="space-y-4"
      >
        {sent ? (
          <Notice>
            {verification
              ? 'หากบัญชียังรอยืนยันอีเมล เราจะส่งลิงก์ยืนยันไปที่'
              : 'หากมีบัญชีนี้ เราจะส่งลิงก์ตั้งรหัสผ่านใหม่ที่ใช้ได้ครั้งเดียวภายใน 30 นาทีไปที่'}{' '}
            <bdi>{sent}</bdi>
          </Notice>
        ) : (
          <Field
            label="อีเมล"
            name="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        )}
        {error && <Notice error>{error}</Notice>}
        {remaining ? (
          <button type="button" disabled className="w-full rounded-full bg-surface-muted p-3 text-sm">
            ส่งอีกครั้งได้ใน {remaining} วินาที
          </button>
        ) : (
          <ActionButton busy={busy}>
            {sent ? 'ส่งอีกครั้ง' : verification ? 'ส่งลิงก์ยืนยัน' : 'ส่งลิงก์รีเซ็ต'}
          </ActionButton>
        )}
        {sent && (
          <button
            type="button"
            disabled={busy}
            className="text-sm text-primary"
            onClick={() => {
              setSent('');
              setError('');
              setNow(Date.now());
            }}
          >
            ใช้อีเมลอื่น
          </button>
        )}
      </form>
      <p className="mt-5 text-center text-sm">
        <Link href="/login" className="text-primary">
          กลับไปเข้าสู่ระบบ
        </Link>
      </p>
    </AuthShell>
  );
}
