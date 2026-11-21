'use client';

import Link from 'next/link';
import { Bell } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '@/auth/session';
import { notificationsApi } from '@/lib/notifications';

const POLL_MS = 60_000;

/** กระดิ่งแจ้งเตือนในแถบบน: เลขที่ยังไม่อ่าน (ไม่แสดงเมื่อ 0) อัปเดตทุก 1 นาทีและเมื่อกลับมาที่แท็บ */
export function NotificationBell() {
  const { request } = useAuth();
  const api = useMemo(() => notificationsApi(request), [request]);
  const [count, setCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => { api.unreadCount().then((value) => { if (!cancelled) setCount(value); }, () => { /* กระดิ่งไม่ควรทำให้หน้าพัง */ }); };
    refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('internpath:notifications-changed', refresh);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); window.removeEventListener('internpath:notifications-changed', refresh); };
  }, [api]);

  return (
    <Link href="/notifications" aria-label={count > 0 ? `การแจ้งเตือน ยังไม่อ่าน ${count} รายการ` : 'การแจ้งเตือน'}
      className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-ink/80 hover:bg-black/[0.05] hover:text-ink">
      <Bell aria-hidden="true" className="h-[18px] w-[18px]" strokeWidth={1.75} />
      {count > 0 && (
        <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-danger-text px-1 text-center text-[11px] font-semibold leading-[18px] text-white">{count > 99 ? '99+' : count}</span>
      )}
    </Link>
  );
}
