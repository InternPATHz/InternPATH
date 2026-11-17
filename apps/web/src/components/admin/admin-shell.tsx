'use client';

import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { useAuth } from '@/auth/session';
import { RequireAuth } from '@/components/layout/require-auth';
import { ADMIN_NAV } from './admin-nav';

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

  const nav = (
    <nav aria-label="เมนู Admin" className="space-y-6">
      {ADMIN_NAV.map((group) => (
        <div key={group.title}>
          <p className="px-3 text-xs font-semibold uppercase tracking-wide text-ink-soft">{group.title}</p>
          <ul className="mt-2 space-y-0.5">
            {group.items.map((item) => {
              const active = item.href !== null && pathname.startsWith(item.href);
              return (
                <li key={item.label}>
                  {item.href ? (
                    <Link
                      href={item.href}
                      aria-current={active ? 'page' : undefined}
                      className={`block rounded-lg px-3 py-2 text-sm ${active ? 'bg-primary-soft font-semibold text-primary' : 'text-ink hover:bg-surface-muted'}`}
                    >
                      {item.label}
                    </Link>
                  ) : (
                    <span className="flex items-center justify-between rounded-lg px-3 py-2 text-sm text-neutral">
                      {item.label}<span className="text-xs">เร็ว ๆ นี้</span>
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );

  return (
    <div className="min-h-screen bg-surface-muted lg:flex">
      <header className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 lg:hidden">
        <Link href="/admin/queue" className="font-bold text-primary">INTERNPATH Admin</Link>
        <button type="button" onClick={() => setMenuOpen((open) => !open)} aria-expanded={menuOpen} aria-controls="admin-sidebar"
          className="rounded-lg border border-border px-3 py-1.5 text-sm">เมนู</button>
      </header>
      <aside id="admin-sidebar" className={`${menuOpen ? 'block' : 'hidden'} border-b border-border bg-surface p-4 lg:sticky lg:top-0 lg:block lg:h-screen lg:w-64 lg:shrink-0 lg:overflow-y-auto lg:border-b-0 lg:border-r`}>
        <Link href="/admin/queue" className="mb-6 hidden px-3 text-lg font-bold text-primary lg:block">INTERNPATH Admin</Link>
        {nav}
        <div className="mt-8 border-t border-border px-3 pt-4 text-sm">
          <p className="truncate font-medium">{user.full_name}</p>
          <p className="truncate text-xs text-ink-soft">{user.email}</p>
          <button type="button" onClick={() => { void logout().finally(() => router.replace('/login')); }}
            className="mt-2 text-primary hover:underline">ออกจากระบบ</button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 p-4 sm:p-6 lg:p-8">{children}</main>
    </div>
  );
}
