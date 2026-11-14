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

export default function RegisterPage() {
  const [role, setRole] = useState<Role>('student');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [registeredEmail, setRegisteredEmail] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const email = String(form.get('email')).trim();
    const password = String(form.get('password'));
    const fullName = String(form.get('full_name')).trim();
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
        {roles.map((item) => <button key={item.id} type="button" onClick={() => { setRole(item.id); setError(''); }}
          aria-pressed={role === item.id}
          className={`rounded-lg border px-2 py-2 text-sm font-medium ${role === item.id ? 'border-primary bg-primary-soft text-primary' : 'border-border text-ink-soft hover:border-primary'}`}>
          {item.label}
        </button>)}
      </div>
      <form key={role} onSubmit={submit} className="space-y-4">
        {role === 'company' && <>
          <Field label="ชื่อบริษัท" name="company_name" required />
          <Field label="เลขทะเบียนนิติบุคคล" name="registration_no" required />
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
        <Field label="รหัสผ่าน (อย่างน้อย 12 ตัวอักษร)" name="password" type="password" minLength={12} autoComplete="new-password" required />
        <label className="flex gap-2 text-sm text-ink-soft">
          <input type="checkbox" name="accept_privacy" required className="mt-1 accent-primary" />
          <span>ยอมรับนโยบายความเป็นส่วนตัวและการเก็บข้อมูลส่วนบุคคล</span>
        </label>
        {error && <Notice error>{error}</Notice>}
        <ActionButton busy={busy}>สมัครสมาชิก</ActionButton>
      </form>
      <p className="mt-5 text-center text-sm text-ink-soft">มีบัญชีแล้ว? <Link href="/login" className="text-primary hover:underline">เข้าสู่ระบบ</Link></p>
    </>}
  </AuthShell>;
}
