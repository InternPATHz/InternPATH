'use client';

import Link from 'next/link';
import { useState } from 'react';
import { Menu, X } from 'lucide-react';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { NotificationBell } from '@/components/notifications/notification-bell';
import { BrandLogo } from '@/components/ui/brand-logo';
import { PUBLIC_NAV, ROLE_NAV } from './site-nav';
import type { NavItem } from './site-nav';

function NavLink({ item, active, onClick }: { item: NavItem; active: boolean; onClick?: () => void }) {
  return <Link href={item.href} onClick={onClick} aria-current={active ? 'page' : undefined} className="whitespace-nowrap text-ink/80 hover:text-ink aria-[current=page]:font-semibold aria-[current=page]:text-primary aria-[current=page]:underline aria-[current=page]:underline-offset-4">{item.label}</Link>;
}

/** เมนูด้านบนของทุกหน้าฝั่งผู้ใช้: เมนูสาธารณะ + เมนูตามบทบาทเมื่อล็อกอินแล้ว */
export function SiteHeader() {
  const router = useRouter();
  const pathname = usePathname().replace(/\/$/, '');
  const [menuOpen, setMenuOpen] = useState(false);
  const { ready, user, logout } = useAuth();
  // แสดงเฉพาะหน้าที่พร้อมแล้ว (`ready: false` ไม่แสดงในเมนู)
  const items: NavItem[] = [...PUBLIC_NAV, ...(user ? ROLE_NAV[user.role] : [])].filter((item) => item.ready);

  async function signOut() {
    try { await logout(); } catch { /* session ในเครื่องถูกล้างเสมอ แม้เซิร์ฟเวอร์ออฟไลน์ */ }
    setMenuOpen(false);
    router.replace('/');
  }

  return (
    <header className="frosted sticky top-0 z-40 border-b border-black/5">
      <div className="mx-auto flex min-h-11 max-w-6xl items-center justify-between gap-3 py-1.5 px-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-5">
          <Link href="/" aria-label="InternPath หน้าแรก" className="text-[15px] font-semibold tracking-wide text-ink">
            <BrandLogo />
          </Link>
          <nav aria-label="เมนูหลัก" className="hidden flex-wrap gap-x-3 gap-y-1 text-[13px] lg:flex">
            {items.map((item) => <NavLink key={item.href} item={item} active={item.href === pathname} />)}
          </nav>
        </div>
        <div className="flex shrink-0 items-center gap-2 text-[13px]">
          {ready && !user && (
            <>
              {pathname !== '/register' && <Link href="/register" className="hidden text-ink/80 hover:text-ink lg:inline">สมัครสมาชิก</Link>}
              {pathname !== '/login' && <Link href="/login" className="rounded-full bg-primary px-4 py-1.5 font-medium text-white hover:bg-primary-hover">เข้าสู่ระบบ</Link>}
            </>
          )}
          {ready && user && (
            <>
              <NotificationBell />
              <Link href="/account" className="rounded-full bg-ink px-4 py-1.5 font-medium text-white hover:bg-ink/85">บัญชี</Link>
              <button type="button" onClick={() => void signOut()} className="hidden whitespace-nowrap text-ink/80 hover:text-ink lg:inline">ออกจากระบบ</button>
            </>
          )}
          <button type="button" className="grid h-9 w-9 place-items-center rounded-full hover:bg-black/5 lg:hidden"
            aria-label={menuOpen ? 'ปิดเมนู' : 'เปิดเมนู'} aria-expanded={menuOpen} aria-controls="site-mobile-nav"
            onClick={() => setMenuOpen((open) => !open)}>
            {menuOpen ? <X size={18} aria-hidden="true" /> : <Menu size={18} aria-hidden="true" />}
          </button>
        </div>
      </div>
      <nav id="site-mobile-nav" aria-label="เมนูหลักบนมือถือ"
        className={`${menuOpen ? 'grid' : 'hidden'} max-h-[70vh] gap-4 overflow-y-auto border-t border-black/5 px-4 py-4 text-sm lg:hidden`}>
        {items.map((item) => <NavLink key={item.href} item={item} active={item.href === pathname} onClick={() => setMenuOpen(false)} />)}
        {ready && !user && pathname !== '/register' && <Link href="/register" onClick={() => setMenuOpen(false)}>สมัครสมาชิก</Link>}
        {ready && user && <button type="button" onClick={() => void signOut()} className="justify-self-start text-ink/80 hover:text-ink">ออกจากระบบ</button>}
      </nav>
    </header>
  );
}
