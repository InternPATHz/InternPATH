'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { SiteHeader } from '@/components/layout/site-header';
import { SiteFooter } from '@/components/layout/site-footer';

export function AuthShell({ title, subtitle, icon, children }: {
  title: string; subtitle?: ReactNode; icon?: ReactNode; children: ReactNode;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  const previousTitle = useRef(title);
  useEffect(() => {
    if (previousTitle.current !== title) heading.current?.focus();
    previousTitle.current = title;
  }, [title]);

  return (
    <div className="flex min-h-screen flex-col bg-surface lg:bg-surface-muted">
      <SiteHeader />
      <main className="mx-auto w-full max-w-lg flex-1 px-5 py-12 [overflow-wrap:anywhere] sm:px-10 sm:py-16 lg:my-8 lg:flex-none lg:rounded-xl lg:border lg:border-border lg:bg-surface lg:py-8">
        <header className="text-center">
          <div aria-hidden="true" className="mx-auto mb-4 grid h-[72px] w-[72px] place-items-center rounded-xl bg-surface-muted text-primary">
            {icon ?? <img src="/logo.png" alt="" width={72} height={72} className="rounded-xl" />}
          </div>
          <h1 ref={heading} tabIndex={-1} className="text-3xl font-semibold leading-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-ink-soft">{subtitle}</p>}
        </header>
        <div className="mt-8">{children}</div>
      </main>
      <SiteFooter />
    </div>
  );
}

export function Field({ label, endAction, ...props }: { label: string; endAction?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const generated = useId();
  const inputId = props.id ?? generated;
  return (
    <div className="relative">
      <label htmlFor={inputId} className="absolute left-3 right-12 top-1.5 truncate text-xs font-medium text-ink-soft">
        {label}{props.required && <span aria-hidden="true" className="text-danger"> *</span>}
      </label>
      <input {...props} id={inputId} className={`h-14 w-full rounded-lg border border-border bg-surface pb-1.5 pl-3 pt-5 text-base text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft ${endAction ? 'pr-12' : 'pr-3'}`} />
      {endAction && <div className="absolute inset-y-0 right-1 flex items-center">{endAction}</div>}
    </div>
  );
}

export function PasswordField(props: Omit<Parameters<typeof Field>[0], 'type' | 'endAction'>) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return <Field {...props} type={visible ? 'text' : 'password'} endAction={
    <button type="button" aria-pressed={visible} aria-label={`${visible ? 'ซ่อน' : 'แสดง'}${props.label}`}
      onClick={() => setVisible((value) => !value)} className="grid h-10 w-10 place-items-center rounded-lg text-ink-soft hover:text-ink">
      <Icon size={18} aria-hidden="true" />
    </button>
  } />;
}

export function NewPasswordFields({ name = 'password', active = true }: { name?: string; active?: boolean }) {
  const prefix = useId();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  return (
    <div className="space-y-3">
      <PasswordField key={`new-${active}`} label="รหัสผ่านใหม่" name={name} value={password} onChange={(event) => setPassword(event.target.value)}
        minLength={12} autoComplete="new-password" aria-describedby={`${prefix}-length`} required />
      <p id={`${prefix}-length`} className={`text-xs ${password.length >= 12 ? 'text-success-text' : 'text-ink-soft'}`}>รหัสผ่านอย่างน้อย 12 ตัวอักษร</p>
      <PasswordField key={`confirm-${active}`} label="ยืนยันรหัสผ่าน" name="confirm_password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)}
        minLength={12} autoComplete="new-password" aria-describedby={confirmation ? `${prefix}-match` : undefined} required />
      {confirmation && <p id={`${prefix}-match`} className={`text-xs ${password === confirmation ? 'text-success-text' : 'text-danger-text'}`}>
        {password === confirmation ? 'รหัสผ่านตรงกัน' : 'รหัสผ่านยังไม่ตรงกัน'}
      </p>}
    </div>
  );
}

export function ActionButton({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return <button type="submit" disabled={busy} className="w-full rounded-full bg-primary px-4 py-3 font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">{busy ? 'กำลังดำเนินการ…' : children}</button>;
}

export function Notice({ children, error = false, focus = false }: { children: ReactNode; error?: boolean; focus?: boolean }) {
  const notice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (focus) notice.current?.focus();
  }, [focus, children]);
  return <p ref={notice} tabIndex={focus ? -1 : undefined} role={error ? 'alert' : 'status'}
    className={`rounded-lg px-4 py-3 text-sm ${error ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text'}`}>{children}</p>;
}
