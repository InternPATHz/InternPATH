'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { PUBLIC_NAV, ROLE_NAV } from './site-nav';
import type { NavItem } from './site-nav';

function NavLink({ item }: { item: NavItem }) {
  if (item.ready) return <Link href={item.href} className="whitespace-nowrap text-ink-soft hover:text-primary">{item.label}</Link>;
  return <span aria-disabled="true" title="เร็ว ๆ นี้" className="cursor-default whitespace-nowrap text-neutral">{item.label}</span>;
}

/** เมนูด้านบนของทุกหน้าฝั่งผู้ใช้: เมนูสาธารณะ + เมนูตามบทบาทเมื่อล็อกอินแล้ว */
export function SiteHeader() {
  const router = useRouter();
  const { ready, user, logout } = useAuth();
  const items: NavItem[] = [...PUBLIC_NAV, ...(user ? ROLE_NAV[user.role] : [])];

  async function signOut() {
    try { await logout(); } catch { /* session ในเครื่องถูกล้างเสมอ แม้เซิร์ฟเวอร์ออฟไลน์ */ }
    router.replace('/');
  }

  return (
    <header className="border-b border-border bg-surface">
      <div className="mx-auto flex h-16 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" className="flex items-center gap-2 text-lg font-bold tracking-wide text-primary">
            <span aria-hidden className="inline-block h-3 w-3 rotate-45 rounded-sm bg-primary" />
            INTERNPATH
          </Link>
          <nav aria-label="เมนูหลัก" className="hidden gap-5 text-sm sm:flex">
            {items.map((item) => <NavLink key={item.href} item={item} />)}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-sm">
          {ready && !user && (
            <>
              <Link href="/register" className="hidden text-ink-soft hover:text-primary sm:inline">สมัครสมาชิก</Link>
              <Link href="/login" className="rounded-full border border-border px-4 py-2 font-medium text-ink hover:border-primary hover:text-primary">เข้าสู่ระบบ</Link>
            </>
          )}
          {ready && user && (
            <>
              <NotificationBell />
              <Link href="/account" className="rounded-full border border-border px-4 py-2 font-medium text-ink hover:border-primary hover:text-primary">บัญชี</Link>
              <button type="button" onClick={() => void signOut()} className="hidden whitespace-nowrap text-ink-soft hover:text-primary sm:inline">ออกจากระบบ</button>
            </>
          )}
        </div>
      </div>
      <nav aria-label="เมนูหลักบนมือถือ" className="flex gap-5 overflow-x-auto border-t border-border px-4 py-2 text-sm sm:hidden">
        {items.map((item) => <NavLink key={item.href} item={item} />)}
        {ready && user && <button type="button" onClick={() => void signOut()} className="whitespace-nowrap text-ink-soft hover:text-primary">ออกจากระบบ</button>}
      </nav>
    </header>
  );
}
