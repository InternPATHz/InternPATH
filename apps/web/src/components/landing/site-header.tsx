'use client';

import Link from 'next/link';
import { useAuth } from '@/auth/session';

const links = [
  { href: '/jobs', label: 'ค้นหางาน' },
  { href: '/companies', label: 'บริษัทและรีวิว' },
];

export function SiteHeader() {
  const { ready, user } = useAuth();
  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-wide text-primary">
            <span aria-hidden className="inline-block h-3 w-3 rotate-45 rounded-sm bg-primary" />
            INTERNPATH
          </Link>
          <nav aria-label="เมนูหลัก" className="hidden gap-5 text-sm sm:flex">
            {links.map((item) => (
              <Link key={item.href} href={item.href} className="text-ink-soft hover:text-primary">{item.label}</Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {ready && !user && (
            <Link href="/register" className="hidden text-ink-soft hover:text-primary sm:inline">สมัครสมาชิก</Link>
          )}
          <Link
            href={ready && !user ? '/login' : '/account'}
            className="rounded-full border border-border px-4 py-2 font-medium text-ink hover:border-primary hover:text-primary"
          >
            {ready && !user ? 'เข้าสู่ระบบ' : 'บัญชี'}
          </Link>
        </div>
      </div>
      <nav aria-label="เมนูหลักบนมือถือ" className="flex gap-5 border-t border-border px-4 py-2 text-sm sm:hidden">
        {links.map((item) => (
          <Link key={item.href} href={item.href} className="text-ink-soft hover:text-primary">{item.label}</Link>
        ))}
      </nav>
    </header>
  );
}
