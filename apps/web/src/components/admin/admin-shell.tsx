'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { RequireAuth } from '@/components/layout/require-auth';
import { BrandLogo } from '@/components/ui/brand-logo';
import { ADMIN_NAV } from './admin-nav';
import { ADMIN_NAV_ICONS } from './admin-nav-icons';

/** เปลือกของหน้า Admin: จำกัดเฉพาะ PLATFORM_ADMIN (ผ่าน RequireAuth) แล้วแสดง Sidebar จัดกลุ่มตาม Service */
export function AdminShell({ children }: { children: ReactNode }) {
  return (
    <RequireAuth roles={['PLATFORM_ADMIN']}>
      <AdminFrame>{children}</AdminFrame>
    </RequireAuth>
  );
}

function AdminFrame({ children }: { children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => { setMenuOpen(false); }, [pathname]);

  if (!user) return null; // RequireAuth ตรวจแล้ว: ถึงตรงนี้ต้องมี user (กันชนิดเป็น null)

  // แสดงเฉพาะรายการที่มีหน้าแล้ว และซ่อนกลุ่มที่ยังไม่มีหน้าเลย (ไม่แสดงเมนูที่กดไม่ได้)
  const groups = ADMIN_NAV
    .map((group) => ({ ...group, items: group.items.filter((item): item is { label: string; href: string } => item.href !== null) }))
    .filter((group) => group.items.length > 0);

  const nav = (
    <nav aria-label="เมนู Admin" className="space-y-6">
      {groups.map((group) => (
        <div key={group.title}>
          <p className="px-3 text-xs font-semibold text-ink-soft">{group.title}</p>
          <ul className="mt-2 space-y-0.5">
            {group.items.map((item) => {
              const active = (pathname === item.href || pathname.startsWith(`${item.href}/`));
              const Icon = ADMIN_NAV_ICONS[item.label];
              return (
                <li key={item.label}>
                  <Link
                    href={item.href}
                    aria-current={active ? 'page' : undefined}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2 text-sm transition-colors ${active ? 'bg-black/[0.06] font-semibold text-ink' : 'text-ink/80 hover:bg-black/[0.04] hover:text-ink'}`}
                  >
                    {Icon && <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${active ? 'text-primary' : 'text-neutral'}`} strokeWidth={1.5} />}
                    {item.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-surface-muted">
      <header className="frosted sticky top-0 z-30 flex min-h-12 items-center justify-between gap-3 border-b border-border px-4 py-2">
        <Link href="/admin/queue" aria-label="INTERNPATH Admin" className="font-semibold text-ink"><BrandLogo label="INTERNPATH Admin" size="sm" /></Link>
        <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="admin-sidebar"
          className="rounded-lg border border-border px-3 py-1.5 text-sm lg:hidden">เมนู</button>
        <div className="hidden items-center gap-4 text-sm lg:flex">
          <span className="max-w-64 truncate text-ink-soft">{user.full_name}</span>
          <button type="button" onClick={() => { void logout().finally(() => router.replace('/login')); }}
            className="text-primary hover:underline">ออกจากระบบ</button>
        </div>
      </header>
      <nav aria-label="ทางลัด Admin บนมือถือ" className="flex gap-2 overflow-x-auto border-b border-border bg-surface px-4 py-2 lg:hidden">
        {groups.flatMap((group) => group.items).map((item) => {
          const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link key={item.href} href={item.href} aria-current={active ? 'page' : undefined}
              className={`shrink-0 rounded-full border px-3 py-1.5 text-sm ${active ? 'border-ink bg-ink text-white' : 'border-border'}`}>{item.label}</Link>
          );
        })}
      </nav>
      <div className="lg:flex">
        <aside id="admin-sidebar" className={`${menuOpen ? 'block' : 'hidden'} border-b border-border bg-surface-muted p-4 lg:sticky lg:top-12 lg:block lg:h-[calc(100vh-3rem)] lg:w-60 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-r`}>
          {nav}
          <div className="mt-8 border-t border-border px-3 pt-4 text-sm lg:hidden">
            <p className="truncate font-medium">{user.full_name}</p>
            <p className="truncate text-xs text-ink-soft">{user.email}</p>
            <button type="button" onClick={() => { void logout().finally(() => router.replace('/login')); }}
              className="mt-2 text-primary hover:underline">ออกจากระบบ</button>
          </div>
        </aside>
        <main className="min-w-0 flex-1 bg-surface p-4 sm:p-6 lg:p-8">{children}</main>
      </div>
    </div>
  );
}
