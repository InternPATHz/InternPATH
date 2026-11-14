import Link from 'next/link';
import type { InputHTMLAttributes, ReactNode } from 'react';

export function AuthShell({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="min-h-screen bg-surface-muted px-4 py-10 sm:py-16">
      <div className="mx-auto max-w-lg">
        <Link href="/" className="mb-8 inline-flex text-xl font-bold text-primary">InternPath</Link>
        <section className="rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="text-2xl font-bold text-ink">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-ink-soft">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </section>
      </div>
    </main>
  );
}

export function Field({ label, ...props }: { label: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="block text-sm font-medium text-ink">
      {label}
      <input {...props} className="mt-1.5 block w-full rounded-lg border border-border bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
    </label>
  );
}

export function ActionButton({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return <button type="submit" disabled={busy} className="w-full rounded-lg bg-primary px-4 py-3 font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">{busy ? 'กำลังดำเนินการ…' : children}</button>;
}

export function Notice({ children, error = false }: { children: ReactNode; error?: boolean }) {
  return <p role={error ? 'alert' : 'status'} className={`rounded-lg px-4 py-3 text-sm ${error ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text'}`}>{children}</p>;
}
