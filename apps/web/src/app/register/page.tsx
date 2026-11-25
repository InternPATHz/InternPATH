'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { Building2, GraduationCap, Mail } from 'lucide-react';
import type { RegisterCompanyRequest } from '@internpath/contracts';
import { ActionButton, AuthShell, Field, NewPasswordFields, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

// นักศึกษาไม่สมัครเอง — อาจารย์ที่ปรึกษาสร้างบัญชีและส่งลิงก์ตั้งรหัสผ่านทางอีเมล (ปรับ Requirement 2026-11-21)
type Role = 'advisor' | 'company';
const roles = [
  { id: 'advisor', label: 'อาจารย์', description: 'ดูแลนักศึกษาและอนุมัติการฝึกงาน', Icon: GraduationCap },
  { id: 'company', label: 'บริษัท', description: 'จัดการประกาศและผู้สมัครฝึกงาน', Icon: Building2 },
] as const;

export default function RegisterPage() {
  const [role, setRole] = useState<Role>('advisor');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [registeredEmail, setRegisteredEmail] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    const password = String(form.get('password'));
    const confirmPassword = String(form.get('confirm_password'));
    const fullName = String(form.get('full_name')).trim();
    if (password !== confirmPassword) {
      setError('รหัสผ่านและยืนยันรหัสผ่านไม่ตรงกัน');
      return;
    }
    setBusy(true);
    setError('');
    try {
      if (role === 'advisor') {
        await apiRequest<void>('/auth/register/advisor', { email, password, full_name: fullName,
          department: String(form.get('department')).trim(), accept_privacy: true });
      } else {
        const website = String(form.get('website') || '').trim();
        const phone = String(form.get('phone') || '').trim();
        const body: RegisterCompanyRequest = {
          company: { name: String(form.get('company_name')).trim(),
            registration_no: String(form.get('registration_no')).trim(),
            ...(website ? { website } : {}), ...(phone ? { phone } : {}) },
          user: { email, password, full_name: fullName }, accept_privacy: true,
        };
        await apiRequest<void>('/auth/register/company', body);
      }
      setRegisteredEmail(email);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'สมัครสมาชิกไม่สำเร็จ');
    } finally { setBusy(false); }
  }

  return <AuthShell title={registeredEmail ? 'ตรวจอีเมลของคุณ' : 'สร้างบัญชี InternPath'} subtitle={registeredEmail ? undefined : 'เลือกประเภทบัญชีเพื่อเริ่มใช้งาน'} icon={registeredEmail ? <Mail size={34} /> : undefined}>
    {registeredEmail ? <div className="space-y-4">
      <Notice>ส่งลิงก์ยืนยันไปที่ {registeredEmail} แล้ว กรุณาตรวจกล่องจดหมาย</Notice>
      {role === 'company' && <p className="text-sm text-ink-soft">หลังยืนยันอีเมล ให้ส่งเอกสารบริษัทเพื่อขอรับการตรวจสอบ</p>}
      {role === 'advisor' && <p className="rounded-lg bg-surface-muted p-3 text-sm text-ink-soft">หลังยืนยันอีเมล บัญชีอาจารย์จะรอผู้ดูแลระบบอนุมัติ</p>}
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/login" className="text-primary hover:underline">ไปหน้าเข้าสู่ระบบ</Link>
        <Link href="/resend-verification" className="text-primary hover:underline">ขอลิงก์ยืนยันใหม่</Link>
      </div>
    </div> : <>
      <p className="mb-4 rounded-lg bg-surface-muted px-4 py-3 text-sm text-ink-soft">นักศึกษาไม่ต้องสมัครเอง อาจารย์ที่ปรึกษาจะเพิ่มบัญชีให้และส่งลิงก์ตั้งรหัสผ่านไปที่อีเมลสถาบัน</p>
      <div className="mb-6 grid gap-2 sm:grid-cols-2" role="group" aria-label="ประเภทบัญชี">
        {roles.map((item) => <button key={item.id} type="button" disabled={busy} onClick={() => {
          setRole(item.id); setError('');
        }}
          aria-pressed={role === item.id}
          className={`flex flex-col items-start rounded-xl border p-4 text-left text-sm font-medium ${role === item.id ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-soft hover:border-primary'}`}>
          <item.Icon size={23} aria-hidden="true" />
          <span className="mt-2 font-semibold">{item.label}</span>
          <span className="mt-1 text-xs text-ink-soft">{item.description}</span>
        </button>)}
      </div>
      {roles.map(({ id: formRole }) => <form key={formRole} hidden={formRole !== role} inert={formRole !== role} onSubmit={submit} className="space-y-4">
        {formRole === 'company' && <fieldset className="space-y-3">
          <legend className="mb-2 font-semibold">ข้อมูลบริษัท</legend>
          <Field label="ชื่อบริษัท" name="company_name" required />
          <Field label="เลขทะเบียนนิติบุคคล" name="registration_no" inputMode="numeric"
            minLength={13} maxLength={13} pattern="[0-9]{13}"
            title="กรุณากรอกเลขทะเบียนนิติบุคคลเป็นตัวเลข 13 หลัก" required />
          <Field label="เว็บไซต์บริษัท (ถ้ามี)" name="website" type="url" placeholder="https://company.example" />
          <Field label="เบอร์โทรบริษัท (ถ้ามี)" name="phone" type="tel" />
        </fieldset>}
        <fieldset className="space-y-3">
          <legend className="mb-2 font-semibold">ข้อมูลบัญชี</legend>
        <Field label={formRole === 'company' ? 'ชื่อผู้ดูแลบริษัท' : 'ชื่อ-นามสกุล'} name="full_name" autoComplete="name" required />
        <Field label={formRole === 'company' ? 'อีเมลองค์กร' : 'อีเมลสถาบัน (.ac.th)'} name="email" type="email" autoComplete="email" required />
        {formRole === 'advisor' && <Field label="ภาควิชา" name="department" required />}
        </fieldset>
        {formRole === 'advisor' && <p className="rounded-lg bg-surface-muted p-3 text-sm text-ink-soft">ใช้อีเมลสถาบันเพื่อยืนยันบทบาท บัญชีจะรอผู้ดูแลระบบอนุมัติหลังยืนยันอีเมล</p>}
        <fieldset className="space-y-3">
          <legend className="mb-2 font-semibold">รหัสผ่าน</legend>
          <NewPasswordFields active={formRole === role} />
        </fieldset>
        <label className="flex gap-2 text-sm text-ink-soft">
          <input type="checkbox" name="accept_privacy" required className="mt-1 accent-primary" />
          <span>ยอมรับ<Link href="/privacy" target="_blank" rel="noopener" className="text-primary hover:underline">นโยบายความเป็นส่วนตัว</Link>และการเก็บข้อมูลส่วนบุคคล<span aria-hidden="true" className="text-danger"> *</span></span>
        </label>
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>สมัครสมาชิก</ActionButton>
      </form>)}
      <p className="mt-5 text-center text-sm text-ink-soft">มีบัญชีแล้ว? <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link></p>
    </>}
  </AuthShell>;
}
