import Link from 'next/link';
import type { InputHTMLAttributes, ReactNode } from 'react';
import { BrandLogo } from '@/components/ui/brand-logo';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-surface-muted px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-lg">
        <Link href="/" aria-label="InternPath หน้าแรก" className="mb-8 inline-flex text-xl font-semibold text-ink"><BrandLogo label="InternPath" size="lg" /></Link>
        <section className="rounded-2xl bg-surface p-6 sm:p-10">
          <h1 className="text-[28px] font-semibold leading-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-ink-soft">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

export function Field({ label, endAction, ...props }: { label: string; endAction?: ReactNode } & InputHTMLAttributes<HTMLInputElement>) {
  const inputId = props.id ?? props.name;
  return (
    <div className="block text-sm font-medium text-ink">
      <label htmlFor={inputId}>{label}{props.required && <span aria-hidden="true" className="text-danger"> *</span>}</label>
      <div className="relative">
        <input {...props} id={inputId} className={`mt-1.5 block w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft ${endAction ? 'pr-12' : ''}`} />
        {endAction && <div className="absolute bottom-0 right-1 top-1.5 flex items-center">{endAction}</div>}
      </div>
    </div>
  );
}

export function ActionButton({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return <button type="submit" disabled={busy} className="w-full rounded-full bg-primary px-4 py-3 font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">{busy ? 'กำลังดำเนินการ…' : children}</button>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p role={error ? 'alert' : 'status'} className={`rounded-lg px-4 py-3 text-sm ${error ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text'}`}>{children}</p>;
}
