'use client';

import { useEffect } from 'react';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import type { Role } from '@internpath/contracts';
import { useAuth } from '@/auth/session';

/**
 * ครอบหน้าที่ต้องล็อกอิน (และจำกัดบทบาทได้): ยังไม่ล็อกอิน ⇒ ส่งไป /login?next=<หน้านี้>;
 * ล็อกอินแล้วแต่บทบาทไม่ตรง ⇒ แสดงหน้า "ไม่มีสิทธิ์" ไม่ redirect (กันวนซ้ำ)
 * เป็นการตรวจฝั่งหน้าจอเท่านั้น — สิทธิ์จริงตรวจที่ Gateway และทุก Service
 */
export function RequireAuth({ roles, children }: { roles?: Role[]; children: ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { ready, user } = useAuth();

  useEffect(() => {
    if (ready && !user) router.replace(`/login?next=${encodeURIComponent(pathname)}`);
  }, [ready, user, pathname, router]);

  if (!ready || !user) return <p className="p-8 text-sm text-ink-soft">กำลังตรวจสอบสิทธิ์…</p>;
  if (roles && !roles.includes(user.role)) {
    return (
      <main className="mx-auto max-w-md p-8 text-center">
        <h1 className="text-xl font-bold">ไม่มีสิทธิ์เข้าหน้านี้</h1>
        <p className="mt-2 text-sm text-ink-soft">หน้านี้สำหรับบทบาทอื่น หากคิดว่าเป็นข้อผิดพลาด กรุณาติดต่อผู้ดูแลระบบ</p>
        <Link href="/" className="mt-4 inline-block text-sm text-primary hover:underline">กลับหน้าแรก</Link>
      </main>
    );
  }
  return <>{children}</>;
}
