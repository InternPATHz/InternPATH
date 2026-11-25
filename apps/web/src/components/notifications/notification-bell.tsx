'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Bell } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { NotificationItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { notificationTarget, notificationsApi } from '@/lib/notifications';

const POLL_MS = 60_000;
const timeFormat = new Intl.DateTimeFormat('th-TH', { timeZone: 'Asia/Bangkok', dateStyle: 'short', timeStyle: 'short' });

export function NotificationBell() {
  const { request } = useAuth();
  const router = useRouter();
  const api = useMemo(() => notificationsApi(request), [request]);
  const button = useRef<HTMLButtonElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<NotificationItem[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    let sequence = 0;
    const refresh = () => {
      const version = ++sequence;
      return api.unreadCount().then((value) => { if (active && version === sequence) setCount(value); }, () => undefined);
    };
    void refresh();
    const timer = setInterval(refresh, POLL_MS);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('internpath:notifications-changed', refresh);
    return () => {
      active = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('internpath:notifications-changed', refresh);
    };
  }, [api]);

  useEffect(() => {
    if (!open) return;
    let active = true;
    setError('');
    let sequence = 0;
    const refresh = () => {
      const version = ++sequence;
      void api.list(1, 5, false).then(
        ({ data }) => { if (active && version === sequence) { setItems(data); setError(''); } },
        () => { if (active && version === sequence) setError('โหลดการแจ้งเตือนไม่สำเร็จ'); },
      );
    };
    refresh();
    window.addEventListener('internpath:notifications-changed', refresh);
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !container.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', dismiss);
    return () => {
      active = false;
      window.removeEventListener('internpath:notifications-changed', refresh);
      document.removeEventListener('pointerdown', dismiss);
    };
  }, [api, open]);

  async function markAllRead() {
    setBusy(true);
    setError('');
    try {
      await api.markAllRead();
      setItems((current) => current?.map((item) => ({ ...item, read: true })) ?? null);
      setCount(0);
      window.dispatchEvent(new Event('internpath:notifications-changed'));
    } catch { setError('ทำเครื่องหมายไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setBusy(false); }
  }

  async function openItem(item: NotificationItem) {
    setOpen(false);
    if (!item.read) {
      try {
        await api.markRead(item.id);
        window.dispatchEvent(new Event('internpath:notifications-changed'));
      } catch { /* The destination remains available if read tracking fails. */ }
    }
    router.push(notificationTarget(item.link) ?? '/notifications');
  }

  return (
    <div className="sm:relative" ref={container} onKeyDown={(event) => {
      if (event.key === 'Escape' && open) { setOpen(false); button.current?.focus(); }
    }}>
      <button ref={button} type="button" aria-label={count > 0 ? `การแจ้งเตือน ยังไม่อ่าน ${count} รายการ` : 'การแจ้งเตือน'}
        aria-expanded={open} aria-controls="recent-notifications" onClick={() => setOpen((value) => !value)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-full text-ink/80 hover:bg-black/5">
        <Bell aria-hidden="true" size={18} strokeWidth={1.75} />
        {count > 0 && (
          <span aria-hidden="true" className="absolute -right-0.5 -top-0.5 min-w-[18px] rounded-full bg-danger-text px-1 text-center text-[11px] font-semibold leading-[18px] text-white">
            {count > 99 ? '99+' : count}
          </span>
        )}
      </button>
      {open && (
        <section id="recent-notifications" aria-labelledby="recent-notifications-title"
          className="absolute inset-x-4 top-full z-50 mt-2 flex max-h-[calc(100dvh-3.75rem)] flex-col overflow-y-auto rounded-xl border border-border bg-surface text-sm text-ink sm:inset-x-auto sm:right-0 sm:w-80">
          <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 p-4">
            <h2 id="recent-notifications-title" className="font-semibold">การแจ้งเตือน</h2>
            <button type="button" disabled={busy || count === 0} onClick={() => void markAllRead()}
              className="text-xs font-semibold text-primary hover:underline disabled:text-ink-soft">อ่านทั้งหมดแล้ว</button>
          </div>
          {error && <p role="alert" className="px-4 pb-3 text-danger-text">{error}</p>}
          {!items && !error && <p role="status" className="px-4 pb-3 text-ink-soft">กำลังโหลด…</p>}
          {items?.length === 0 && <p className="px-4 pb-3 text-ink-soft">ยังไม่มีการแจ้งเตือน</p>}
          {!!items?.length && (
            <ul className="max-h-64 min-h-0 overflow-y-auto border-t border-border">
              {items.map((item) => (
                <li key={item.id} className="border-b border-border">
                  <button type="button" onClick={() => void openItem(item)} className="flex w-full items-start gap-3 px-4 py-3 text-left hover:bg-surface-muted">
                    <span aria-hidden="true" className={`mt-2 h-2 w-2 shrink-0 rounded-full ${item.read ? 'bg-transparent' : 'bg-primary'}`} />
                    <span className="min-w-0">
                      <span className={`block break-words ${item.read ? '' : 'font-semibold'}`}>{item.title}</span>
                      <time dateTime={item.created_at} className="block text-xs text-ink-soft">{timeFormat.format(new Date(item.created_at))}</time>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <Link href="/notifications" onClick={() => setOpen(false)} className="block shrink-0 px-4 py-3 text-center font-medium text-primary hover:underline">ดูการแจ้งเตือนทั้งหมด ›</Link>
        </section>
      )}
    </div>
  );
}
