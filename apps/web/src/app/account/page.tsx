'use client';

import Link from 'next/link';
import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
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

const link = 'font-medium text-primary hover:underline';

function Row({ label, children }: { label: string; children: ReactNode }) {
  return <div className="grid gap-1 border-b border-border py-3 sm:grid-cols-[10rem_minmax(0,1fr)]"><dt className="text-ink-soft">{label}</dt><dd>{children}</dd></div>;
}

export default function AccountPage() {
  return <RequireAuth><AccountContent /></RequireAuth>;
}

function AccountContent() {
  const { user, request } = useAuth();
  const [profile, setProfile] = useState<UserMeResponse | null>(null);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    let active = true;
    setError('');
    request<UserMeResponse>('/users/me').then((data) => { if (active) setProfile(data); },
      (cause) => { if (active) setError(cause instanceof Error ? cause.message : 'โหลดข้อมูลบัญชีไม่สำเร็จ'); });
    return () => { active = false; };
  }, [user?.id, request, retry]);

  useEffect(() => {
    if (profile && window.location.hash === '#advisor') document.getElementById('advisor')?.scrollIntoView();
  }, [profile?.id]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    setMessage('');
    try {
      const updated = await request<UserMeResponse>('/users/me', { method: 'PATCH', body: { full_name: name.trim() } });
      setProfile(updated); setEditing(false); setMessage('บันทึกชื่อแล้ว');
    } catch (cause) { setMessage(cause instanceof Error ? cause.message : 'บันทึกชื่อไม่สำเร็จ'); }
    finally { setBusy(false); }
  }

  const student = profile?.student;
  return <div className="flex min-h-screen flex-col"><SiteHeader />
    <main className="mx-auto w-full max-w-3xl flex-1 space-y-7 px-4 py-9 [overflow-wrap:anywhere] sm:px-6">
      <h1 className="text-3xl font-semibold">บัญชีของฉัน</h1>
      {error ? <Notice error>{error} <button onClick={() => setRetry((r) => r + 1)} className={link}>ลองอีกครั้ง</button></Notice> : !profile && <p role="status">กำลังโหลดข้อมูลบัญชี…</p>}
      {profile && <>
        <header className="flex items-center gap-4"><Avatar name={profile.full_name} size="lg" />
          <div className="min-w-0"><h2 className="text-2xl font-semibold">{profile.full_name}</h2>
            <p className="text-sm text-ink-soft">{labelOf(ROLE_LABEL, profile.role)} · {labelOf(USER_STATUS_LABEL, profile.status)}</p></div>
        </header>
        <nav aria-label="ส่วนของบัญชี" className="flex flex-wrap gap-4 text-sm text-primary"><a href="#account-info">ข้อมูลบัญชี</a>
          {student && <a href="#advisor">อาจารย์ที่ปรึกษา</a>}<a href="#security">ความปลอดภัย</a><a href="#privacy">ความเป็นส่วนตัว</a></nav>
        <section id="account-info" className="scroll-mt-20"><h2 className="text-lg font-semibold">ข้อมูลบัญชี</h2>
          <dl className="text-sm"><Row label="อีเมล">{profile.email} · {profile.email_verified ? 'ยืนยันแล้ว' : 'รอยืนยัน'}</Row>
            {student && <><Row label="รหัสนักศึกษา">{student.student_code}</Row><Row label="สาขาและชั้นปี">{student.major} · ชั้นปี {student.year_level}</Row></>}
            {profile.university && <Row label="มหาวิทยาลัย">{profile.university.name}</Row>}
            {profile.advisor?.department && <Row label="ภาควิชา">{profile.advisor.department}</Row>}
            {profile.company && <><Row label="บริษัท"><Link href="/hr/company" className={link}>{profile.company.name}</Link></Row>
              <Row label="บทบาทในทีม"><Link href="/hr/team" className={link}>{profile.company.member_role === 'OWNER' ? 'เจ้าของบัญชีบริษัท' : 'สมาชิก HR'}</Link></Row></>}
          </dl>
          <details className="mt-3 text-sm"><summary className="cursor-pointer">รหัสอ้างอิงบัญชี</summary><p className="mt-2 flex items-center gap-2 font-mono">{profile.id}<CopyButton value={profile.id} label="คัดลอกรหัสบัญชี" /></p></details>
          {editing ? <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={save}><label className="text-sm">ชื่อและนามสกุล<input autoFocus required value={name} onChange={(e) => setName(e.target.value)} className="mt-1 block rounded-lg border border-border px-3 py-2" /></label>
            <button disabled={busy || !name.trim()} className={link}>บันทึกชื่อ</button><button type="button" disabled={busy} onClick={() => { setEditing(false); setMessage(''); }}>ยกเลิก</button></form>
            : <button className={link + ' mt-3 text-sm'} onClick={() => { setName(profile.full_name); setEditing(true); setMessage(''); }}>แก้ไขชื่อ</button>}
          {message && <p role="status" className="mt-2 text-sm">{message}</p>}
        </section>
        {student && <section id="advisor" className="scroll-mt-20 rounded-xl bg-surface-muted p-5"><h2 className="text-lg font-semibold">อาจารย์ที่ปรึกษา</h2>
          <p className="mt-2">{labelOf(ADVISOR_LINK_LABEL, student.advisor_link_status)}</p><p className="mt-1 text-sm">{student.advisor_link_status === 'LINKED' ? 'หลังคุณยืนยันข้อเสนอ อาจารย์จะพิจารณาอนุมัติการฝึกงาน' : 'กรุณาติดต่ออาจารย์หรือผู้ดูแลระบบของสถาบันเพื่อตรวจสอบการเชื่อมบัญชี'}</p>
          <div className="mt-3 flex gap-4 text-sm"><Link className={link} href="/student/profile">โปรไฟล์และเรซูเม่</Link>{student.advisor_link_status === 'LINKED' && <Link className={link} href="/jobs">ค้นหางาน</Link>}</div></section>}
        <section id="security" className="scroll-mt-20"><h2 className="mb-2 text-lg font-semibold">ความปลอดภัย</h2><Link href="/forgot-password" className={link}>ขอลิงก์ตั้งรหัสผ่านใหม่ ›</Link></section>
        <section id="privacy" className="scroll-mt-20"><h2 className="mb-2 text-lg font-semibold">ความเป็นส่วนตัว</h2><Link href="/privacy" className={link}>นโยบายความเป็นส่วนตัว ›</Link>
          <div className="mt-4 border-t border-border pt-4"><Link href="/account/delete" className="font-medium text-danger-text">ลบบัญชี ›</Link></div></section>
        <Link href={ROLE_HOME[profile.role]} className={link}>กลับหน้าหลัก</Link>
      </>}
    </main><SiteFooter /></div>;
}
