'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { AuthShell, Notice } from '@/auth/ui';
import { RequireAuth } from '@/components/layout/require-auth';
import { ROLE_HOME } from '@/components/layout/site-nav';
import { ADVISOR_LINK_LABEL, ROLE_LABEL, USER_STATUS_LABEL, labelOf } from '@/lib/status-map';

export default function AccountPage() {
  return <RequireAuth><AccountContent /></RequireAuth>;
}

function AccountContent() {
  const router = useRouter();
  const { user, logout, request } = useAuth();
  const userId = user?.id;
  const [profile, setProfile] = useState<UserMeResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // ผูกกับ user.id ไม่ใช่ object user: การ refresh token สร้าง object ใหม่ทุกครั้ง
  // ถ้าอิง object จะโหลดซ้ำวน (และวนไม่รู้จบเมื่อ /users/me ตอบ 401 ซ้ำ)
  useEffect(() => {
    if (!userId) return;
    let active = true;
    void request<UserMeResponse>('/users/me')
      .then((data) => { if (active) setProfile(data); })
      .catch((cause) => { if (active) setError(cause instanceof Error ? cause.message : 'โหลดข้อมูลบัญชีไม่สำเร็จ'); });
    return () => { active = false; };
  }, [userId, request]);

  async function signOut() {
    setBusy(true);
    try { await logout(); }
    catch { /* The local session is cleared even if the server is offline. */ }
    router.replace('/login');
  }

  return <AuthShell title="บัญชีของฉัน" subtitle="ข้อมูลบัญชีที่ใช้เข้าสู่ระบบ InternPath">
    {!profile && !error ? <p className="text-sm text-ink-soft">กำลังโหลดข้อมูลบัญชี…</p> : <div className="space-y-5">
      {error && <Notice error>{error}</Notice>}
      {profile && <dl className="grid gap-4 rounded-xl bg-surface-muted p-5 text-sm sm:grid-cols-2">
        <div><dt className="text-ink-soft">ชื่อ</dt><dd className="mt-1 font-medium">{profile.full_name}</dd></div>
        <div><dt className="text-ink-soft">บทบาท</dt><dd className="mt-1 font-medium">{labelOf(ROLE_LABEL, profile.role)}</dd></div>
        <div><dt className="text-ink-soft">อีเมล</dt><dd className="mt-1 break-all font-medium">{profile.email}</dd></div>
        <div><dt className="text-ink-soft">สถานะ</dt><dd className="mt-1 font-medium">{labelOf(USER_STATUS_LABEL, profile.status)}</dd></div>
        {profile.company && <div><dt className="text-ink-soft">บริษัท</dt><dd className="mt-1 font-medium">{profile.company.name}</dd></div>}
        {profile.student && <div><dt className="text-ink-soft">สถานะอาจารย์ที่ปรึกษา</dt><dd className="mt-1 font-medium">{labelOf(ADVISOR_LINK_LABEL, profile.student.advisor_link_status)}</dd></div>}
      </dl>}
      <div className="flex flex-wrap items-center gap-4">
        <button type="button" disabled={busy} onClick={signOut}
          className="rounded-full border border-border px-4 py-2.5 font-medium text-ink hover:bg-surface-muted disabled:opacity-50">
          {busy ? 'กำลังออกจากระบบ…' : 'ออกจากระบบ'}
        </button>
        <Link href={profile ? ROLE_HOME[profile.role] ?? '/' : '/'} className="text-sm text-primary hover:underline">กลับหน้าหลัก</Link>
        <Link href="/account/delete" className="text-sm text-danger-text hover:underline">ลบบัญชี</Link>
      </div>
    </div>}
  </AuthShell>;
}
