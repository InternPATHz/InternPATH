'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import type { Role } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { ROLE_HOME } from './site-nav';

/**
 * ครอบหน้าที่ต้องล็อกอิน (และจำกัดบทบาทได้)
 * - ยังไม่ล็อกอิน ⇒ /login?next=<หน้านี้ พร้อม query/hash> • ถ้าเพิ่งกดออกจากระบบเอง ⇒ /login (ไม่จำหน้า คนถัดไปอาจเป็นบทบาทอื่น)
 * - ล็อกอินแล้วแต่บทบาทไม่ตรง ⇒ ไปหน้าแรกของบทบาทตัวเอง (ROLE_HOME เป็นหน้าของบทบาทนั้นเสมอ จึงไม่วนซ้ำ) และไม่ render เนื้อหาของหน้านี้
 * เป็นการตรวจฝั่งหน้าจอเท่านั้น — สิทธิ์จริงตรวจที่ Gateway และทุก Service
 */
export function RequireAuth({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { ready, user, signedOut } = useAuth();
  const allowed = !!user && (!roles || roles.includes(user.role));

  useEffect(() => {
    if (!ready) return;
    if (!user) {
      const { search, hash } = window.location;
      router.replace(signedOut ? '/login' : `/login?next=${encodeURIComponent(pathname + search + hash)}`);
    } else if (!allowed) {
      router.replace(ROLE_HOME[user.role] ?? '/account');
    }
  }, [ready, user, allowed, signedOut, pathname, router]);

  if (!ready || !allowed) return <p className="p-8 text-sm text-ink-soft">กำลังตรวจสอบสิทธิ์…</p>;
  return <>{children}</>;
}
