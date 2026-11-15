'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import type { RegisterCompanyRequest, RegisterStudentRequest } from '@internpath/contracts';
import { ActionButton, AuthShell, Field, Notice } from '@/auth/ui';
import { apiRequest } from '@/lib/api';

type Role = 'student' | 'advisor' | 'company';
const roles: Array<{ id: Role; label: string }> = [
  { id: 'student', label: 'นักศึกษา' },
  { id: 'advisor', label: 'อาจารย์' },
  { id: 'company', label: 'บริษัท' },
];

function VisibilityButton({ visible, onToggle }: { visible: boolean; onToggle: () => void }) {
  return <button type="button" onClick={onToggle} aria-label={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
    title={visible ? 'ซ่อนรหัสผ่าน' : 'แสดงรหัสผ่าน'}
    aria-pressed={visible} className="flex h-10 w-10 items-center justify-center rounded-md text-ink-soft hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"
      strokeLinecap="round" strokeLinejoin="round" className="h-5 w-5">
      {visible ? <>
        <path d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z" />
        <circle cx="12" cy="12" r="3" />
      </> : <>
        <path d="M2 14c3-3.5 6.5-5.2 10-5.2S19 10.5 22 14" />
        <path d="M5 12.1 3.5 16M9 9.6 8.5 14M15 9.6 15.5 14M19 12.1 20.5 16" />
      </>}
    </svg>
  </button>;
}

export default function RegisterPage() {
  const [role, setRole] = useState<Role>('student');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [registeredEmail, setRegisteredEmail] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);

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
      if (role === 'student') {
        const body: RegisterStudentRequest = { email, password, full_name: fullName,
          student_code: String(form.get('student_code')).trim(), major: String(form.get('major')).trim(),
          year_level: Number(form.get('year_level')), accept_privacy: true };
        await apiRequest<void>('/auth/register/student', body);
      } else if (role === 'advisor') {
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

  return <AuthShell title="สมัครสมาชิก" subtitle="เลือกบทบาทและกรอกข้อมูลเพื่อรับลิงก์ยืนยันอีเมล">
    {registeredEmail ? <div className="space-y-4">
      <Notice>ส่งลิงก์ยืนยันไปที่ {registeredEmail} แล้ว กรุณาตรวจกล่องจดหมาย</Notice>
      <p className="text-sm text-ink-soft">บัญชีอาจารย์ต้องรอ Admin อนุมัติหลังยืนยันอีเมล</p>
      <div className="flex flex-wrap gap-4 text-sm">
        <Link href="/login" className="text-primary hover:underline">ไปหน้าเข้าสู่ระบบ</Link>
        <Link href="/resend-verification" className="text-primary hover:underline">ขอลิงก์ยืนยันใหม่</Link>
      </div>
    </div> : <>
      <div className="mb-6 grid grid-cols-3 gap-2" role="group" aria-label="ประเภทบัญชี">
        {roles.map((item) => <button key={item.id} type="button" onClick={() => {
          setRole(item.id); setError(''); setShowPassword(false); setShowConfirmPassword(false);
        }}
          aria-pressed={role === item.id}
          className={`rounded-lg border px-2 py-2 text-sm font-medium ${role === item.id ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-soft hover:border-primary'}`}>
          {item.label}
        </button>)}
      </div>
      <form key={role} onSubmit={submit} className="space-y-4">
        {role === 'company' && <>
          <Field label="ชื่อบริษัท" name="company_name" required />
          <Field label="เลขทะเบียนนิติบุคคล" name="registration_no" inputMode="numeric"
            minLength={13} maxLength={13} pattern="[0-9]{13}"
            title="กรุณากรอกเลขทะเบียนนิติบุคคลเป็นตัวเลข 13 หลัก" required />
          <Field label="เว็บไซต์บริษัท (ถ้ามี)" name="website" type="url" placeholder="https://company.example" />
          <Field label="เบอร์โทรบริษัท (ถ้ามี)" name="phone" type="tel" />
        </>}
        <Field label={role === 'company' ? 'ชื่อผู้ดูแลบริษัท' : 'ชื่อ-นามสกุล'} name="full_name" autoComplete="name" required />
        <Field label={role === 'company' ? 'อีเมลองค์กร' : 'อีเมลสถาบัน (.ac.th)'} name="email" type="email" autoComplete="email" required />
        {role === 'student' && <>
          <Field label="รหัสนักศึกษา" name="student_code" required />
          <Field label="สาขาวิชา" name="major" required />
          <Field label="ชั้นปี" name="year_level" type="number" min={1} max={10} required />
        </>}
        {role === 'advisor' && <Field label="ภาควิชา" name="department" required />}
        <Field label="รหัสผ่าน (อย่างน้อย 12 ตัวอักษร)" name="password"
          type={showPassword ? 'text' : 'password'} minLength={12} autoComplete="new-password" required
          endAction={<VisibilityButton visible={showPassword} onToggle={() => setShowPassword((value) => !value)} />} />
        <Field label="ยืนยันรหัสผ่าน" name="confirm_password"
          type={showConfirmPassword ? 'text' : 'password'} minLength={12} autoComplete="new-password" required
          endAction={<VisibilityButton visible={showConfirmPassword} onToggle={() => setShowConfirmPassword((value) => !value)} />} />
        <label className="flex gap-2 text-sm text-ink-soft">
          <input type="checkbox" name="accept_privacy" required className="mt-1 accent-primary" />
          <span>ยอมรับนโยบายความเป็นส่วนตัวและการเก็บข้อมูลส่วนบุคคล<span aria-hidden="true" className="text-danger"> *</span></span>
        </label>
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>สมัครสมาชิก</ActionButton>
      </form>
      <p className="mt-5 text-center text-sm text-ink-soft">มีบัญชีแล้ว? <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link></p>
    </>}
  </AuthShell>;
}
