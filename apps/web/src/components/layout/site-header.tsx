'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { BrandLogo } from '@/components/ui/brand-logo';
import { PUBLIC_NAV, ROLE_NAV } from './site-nav';
import type { NavItem } from './site-nav';

function NavLink({ item }: { item: NavItem }) {
  return <Link href={item.href} className="whitespace-nowrap text-ink/80 hover:text-ink">{item.label}</Link>;
}

/** เมนูด้านบนของทุกหน้าฝั่งผู้ใช้: เมนูสาธารณะ + เมนูตามบทบาทเมื่อล็อกอินแล้ว */
export function SiteHeader() {
  const router = useRouter();
  const { ready, user, logout } = useAuth();
  // แสดงเฉพาะหน้าที่พร้อมแล้ว (`ready: false` ไม่แสดงในเมนู)
  const items: NavItem[] = [...PUBLIC_NAV, ...(user ? ROLE_NAV[user.role] : [])].filter((item) => item.ready);

  async function signOut() {
    try { await logout(); } catch { /* session ในเครื่องถูกล้างเสมอ แม้เซิร์ฟเวอร์ออฟไลน์ */ }
    router.replace('/');
  }

  return (
    <header className="frosted sticky top-0 z-40 border-b border-black/5">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between gap-4 px-4 sm:px-6">
        <div className="flex items-center gap-6">
          <Link href="/" aria-label="InternPath หน้าแรก" className="text-[15px] font-semibold tracking-wide text-ink">
            <BrandLogo />
          </Link>
          <nav aria-label="เมนูหลัก" className="hidden gap-6 text-[13px] sm:flex">
            {items.map((item) => <NavLink key={item.href} item={item} />)}
          </nav>
        </div>
        <div className="flex items-center gap-3 text-[13px]">
          {ready && !user && (
            <>
              <Link href="/register" className="hidden text-ink/80 hover:text-ink sm:inline">สมัครสมาชิก</Link>
              <Link href="/login" className="rounded-full bg-primary px-4 py-1.5 font-medium text-white hover:bg-primary-hover">เข้าสู่ระบบ</Link>
            </>
          )}
          {ready && user && (
            <>
              <NotificationBell />
              <Link href="/account" className="rounded-full bg-ink px-4 py-1.5 font-medium text-white hover:bg-ink/85">บัญชี</Link>
              <button type="button" onClick={() => void signOut()} className="hidden whitespace-nowrap text-ink/80 hover:text-ink sm:inline">ออกจากระบบ</button>
            </>
          )}
        </div>
      </div>
      <nav aria-label="เมนูหลักบนมือถือ" className="flex gap-5 overflow-x-auto border-t border-black/5 px-4 py-2 text-[13px] sm:hidden">
        {items.map((item) => <NavLink key={item.href} item={item} />)}
        {ready && user && <button type="button" onClick={() => void signOut()} className="whitespace-nowrap text-ink/80 hover:text-ink">ออกจากระบบ</button>}
      </nav>
    </header>
  );
}
