'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/auth/ui';
import { SiteHeader } from '@/components/layout/site-header';
import { SiteFooter } from '@/components/layout/site-footer';
import { Avatar } from '@/components/ui/avatar';
import { CopyButton } from '@/components/ui/copy-button';
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

  const role = profile?.role ?? user?.role;

  return (
    <div className="flex min-h-screen flex-col">
      <SiteHeader />
      <main className="mx-auto grid w-full max-w-5xl flex-1 gap-8 px-4 py-12 sm:px-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <header>
          <Avatar name={profile?.full_name ?? user?.full_name} size="lg" />
          <h1 className="mt-4 break-words text-3xl font-semibold">{profile?.full_name ?? user?.full_name ?? 'บัญชีของฉัน'}</h1>
          {role && <p className="mt-1 text-sm text-ink-soft">{labelOf(ROLE_LABEL, role)}</p>}
          <button type="button" disabled={busy} onClick={signOut}
            className="mt-5 rounded-full border border-border px-4 py-2 text-sm font-medium hover:bg-surface-muted disabled:opacity-50">
            {busy ? 'กำลังออกจากระบบ…' : 'ออกจากระบบ'}
          </button>
        </header>
        <div className="min-w-0 space-y-6">
          {!profile && !error && <p role="status" className="text-sm text-ink-soft">กำลังโหลดข้อมูลบัญชี…</p>}
          {error && <Notice error>{error}</Notice>}
          {profile && (
            <section aria-labelledby="account-info">
              <h2 id="account-info" className="text-lg font-semibold">ข้อมูลบัญชี</h2>
              <dl className="mt-2 divide-y divide-border rounded-xl bg-surface-muted px-4 text-sm">
                {([
                  ['ชื่อ', profile.full_name],
                  ['อีเมล', profile.email],
                  ...(profile.student ? [['รหัสนักศึกษา', profile.student.student_code]] : []),
                  ['บทบาท', labelOf(ROLE_LABEL, profile.role)],
                  ['สถานะบัญชี', labelOf(USER_STATUS_LABEL, profile.status)],
                ] as Array<[string, string]>).map(([label, value]) => (
                  <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-3">
                    <dt className="text-ink-soft">{label}</dt>
                    <dd className="break-all font-medium">{value}</dd>
                  </div>
                ))}
                {/* รหัสบัญชี (UUID) คือรหัสที่ Admin ใช้ในฟอร์มย้ายอาจารย์ที่ปรึกษา — แจ้ง Admin ได้โดยไม่ต้องค้นเอง */}
                <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 py-3">
                  <dt className="text-ink-soft">รหัสบัญชี</dt>
                  <dd className="flex min-w-0 items-center gap-2">
                    <span className="break-all font-mono text-xs">{profile.id}</span>
                    <CopyButton value={profile.id} label="คัดลอกรหัสบัญชี" />
                  </dd>
                </div>
              </dl>
            </section>
          )}
          {(profile?.student || profile?.company || profile?.advisor) && (
            <section aria-labelledby="account-training">
              <h2 id="account-training" className="text-lg font-semibold">การฝึกงาน</h2>
              <ul className="mt-2 divide-y divide-border rounded-xl bg-surface-muted px-4 text-sm">
                {profile.student && <>
                  <li className="flex flex-wrap justify-between gap-2 py-3"><span>สถานะอาจารย์ที่ปรึกษา</span><span className="font-medium">{labelOf(ADVISOR_LINK_LABEL, profile.student.advisor_link_status)}</span></li>
                  <li><Link href="/student/profile" className="block py-3 text-primary hover:underline">โปรไฟล์และเรซูเม่ ›</Link></li>
                </>}
                {profile.company && <>
                  <li><Link href="/hr/company" className="block py-3 text-primary hover:underline">บริษัทของฉัน · {profile.company.name} ›</Link></li>
                  <li><Link href="/hr/team" className="block py-3 text-primary hover:underline">ทีม HR ›</Link></li>
                </>}
                {profile.advisor?.department && <li className="py-3">ภาควิชา · {profile.advisor.department}</li>}
              </ul>
            </section>
          )}
          <section aria-labelledby="account-privacy">
            <h2 id="account-privacy" className="text-lg font-semibold">ความปลอดภัยและความเป็นส่วนตัว</h2>
            <ul className="mt-2 divide-y divide-border rounded-xl bg-surface-muted px-4 text-sm">
              <li><Link href="/forgot-password" className="block py-3 text-primary hover:underline">ขอลิงก์ตั้งรหัสผ่านใหม่ ›</Link></li>
              <li><Link href="/privacy" className="block py-3 text-primary hover:underline">นโยบายความเป็นส่วนตัว ›</Link></li>
              <li><Link href="/account/delete" className="block py-3 text-danger-text hover:underline">ลบบัญชี ›</Link></li>
            </ul>
          </section>
          <Link href={role ? ROLE_HOME[role] : '/'} className="inline-block text-sm text-primary hover:underline">กลับหน้าหลัก</Link>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
