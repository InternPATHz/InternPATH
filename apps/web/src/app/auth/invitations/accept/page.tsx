'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { Building2, CircleCheck } from 'lucide-react';
import { ActionButton, AuthShell, Field, NewPasswordFields, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

// ลิงก์ในอีเมลเชิญสมาชิก HR (Identity ส่ง `/auth/invitations/accept?token=`) — token ใช้ได้ครั้งเดียว
export default function AcceptInvitationPage() {
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => { setToken(new URLSearchParams(window.location.search).get('token') || ''); }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const password = String(form.get('password'));
    if (password !== form.get('confirm_password')) { setError('รหัสผ่านทั้งสองช่องไม่ตรงกัน'); return; }
    setBusy(true);
    setError('');
    try {
      await apiRequest<void>('/auth/invitations/accept', { token, password, full_name: String(form.get('full_name')).trim() });
      setDone(true);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'ตอบรับคำเชิญไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  return (
    <AuthShell title={done ? 'ยินดีต้อนรับสู่ทีม' : 'เข้าร่วมทีมบริษัท'} subtitle={done ? undefined : 'ตั้งชื่อและรหัสผ่านเพื่อเปิดบัญชี HR ของบริษัทที่เชิญคุณ'} icon={done ? <CircleCheck size={34} /> : <Building2 size={34} />}>
      {done ? (
        <div className="space-y-4">
          <Notice>เปิดบัญชีสำเร็จแล้ว เข้าสู่ระบบด้วยอีเมลที่ได้รับคำเชิญได้เลย</Notice>
          <Link href="/login" className="block rounded-full bg-primary px-4 py-3 text-center font-semibold text-white hover:bg-primary-hover">เข้าสู่ระบบ</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="space-y-4">
          {!token && <Notice error>ไม่พบ token ในลิงก์ กรุณาเปิดลิงก์จากอีเมลคำเชิญอีกครั้ง</Notice>}
          {error && <Notice error>{error}</Notice>}
          <Field label="ชื่อ-นามสกุล" name="full_name" autoComplete="name" required />
          <NewPasswordFields />
          <ActionButton busy={busy}>เปิดบัญชีและเข้าร่วมทีม</ActionButton>
        </form>
      )}
    </AuthShell>
  );
}
