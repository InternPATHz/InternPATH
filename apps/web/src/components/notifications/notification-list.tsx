'use client';

import Link from 'next/link';
import { Bell, ChevronRight, ClipboardList, Clock, FileCheck, Shield } from 'lucide-react';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { NotificationItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';
import { notificationTarget, notificationsApi } from '@/lib/notifications';

const PAGE_SIZE = 20;
const timeZone = 'Asia/Bangkok';
const dayFormat = new Intl.DateTimeFormat('sv-SE', { timeZone, dateStyle: 'short' });
const timeFormat = new Intl.DateTimeFormat('th-TH', { timeZone, timeStyle: 'short' });
const dateFormat = new Intl.DateTimeFormat('th-TH', { timeZone, dateStyle: 'medium' });

function iconFor(type: string) {
  if (/reminder|sla|due/i.test(type)) return Clock;
  if (/certificate|credential/i.test(type)) return FileCheck;
  if (/application|offer|job/i.test(type)) return ClipboardList;
  if (/security|account|login/i.test(type)) return Shield;
  return Bell;
}

export function NotificationList() {
  const router = useRouter();
  const { request } = useAuth();
  const api = useMemo(() => notificationsApi(request), [request]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<NotificationItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unreadCount, setUnreadCount] = useState<number | null>(null);

  const sequence = useRef(0);
  const load = useCallback(async () => {
    const version = ++sequence.current;
    try {
      const next = await api.list(page, PAGE_SIZE, unreadOnly);
      if (version !== sequence.current) return;
      const last = Math.max(1, Math.ceil(next.meta.total / PAGE_SIZE));
      if (page > last) { setPage(last); return; }
      setResult(next);
      setError(null);
    } catch (cause) {
      if (version !== sequence.current) return;
      setError(cause instanceof ApiError ? cause.message : 'โหลดการแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่');
    }
    api.unreadCount().then(
      (count) => { if (version === sequence.current) setUnreadCount(count); },
      () => { if (version === sequence.current) setUnreadCount(null); },
    );
  }, [api, page, unreadOnly]);

  useEffect(() => {
    setResult(null);
    void load();
    const refresh = () => { void load(); };
    window.addEventListener('internpath:notifications-changed', refresh);
    return () => { sequence.current++; window.removeEventListener('internpath:notifications-changed', refresh); };
  }, [load]);

  const changed = () => window.dispatchEvent(new Event('internpath:notifications-changed'));

  async function open(item: NotificationItem) {
    if (!item.read) {
      try { await api.markRead(item.id); changed(); } catch { setError('ทำเครื่องหมายว่าอ่านแล้วไม่สำเร็จ'); }
    }
    const target = notificationTarget(item.link);
    if (target) router.push(target);
  }

  async function readAll() {
    setBusy(true);
    try { await api.markAllRead(); changed(); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'ทำเครื่องหมายไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setBusy(false); }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  const hasUnread = unreadCount === null ? result?.data.some((item) => !item.read) : unreadCount > 0;
  const now = Date.now();
  const today = dayFormat.format(now);
  const yesterday = dayFormat.format(now - 86_400_000);
  const groups = [
    { title: 'วันนี้', items: [] as NotificationItem[] },
    { title: 'เมื่อวาน', items: [] as NotificationItem[] },
    { title: 'ก่อนหน้านี้', items: [] as NotificationItem[] },
  ];
  for (const item of result?.data ?? []) {
    const day = dayFormat.format(new Date(item.created_at));
    groups[day === today ? 0 : day === yesterday ? 1 : 2].items.push(item);
  }
  return (
    <main className="bg-surface-muted px-4 py-10 sm:px-6">
      <div className="mx-auto max-w-3xl">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-3xl font-semibold">การแจ้งเตือน</h1>
          </div>
          <button type="button" disabled={busy || !hasUnread} onClick={() => void readAll()} className="text-sm font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50">
            อ่านทั้งหมดแล้ว
          </button>
        </div>

        <div role="group" aria-label="กรองการแจ้งเตือน" className="mt-5 inline-flex gap-1 rounded-full border border-border bg-surface p-1">
          {[['ทั้งหมด', false], ['ยังไม่อ่าน', true]].map(([label, value]) => (
            <button key={String(label)} type="button" aria-pressed={unreadOnly === value} onClick={() => { setUnreadOnly(value as boolean); setPage(1); }}
              className={`rounded-full border px-4 py-1.5 text-sm font-medium ${unreadOnly === value ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
              {label as string}{value && unreadCount !== null && ` (${unreadCount})`}
            </button>
          ))}
        </div>

        <section aria-busy={!result && !error} className="mt-5">
          {error && <Notice tone="error">{error} <button type="button" onClick={() => void load()} className="underline">โหลดอีกครั้ง</button></Notice>}
          {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
          {result && result.data.length === 0 && (
            <div className="rounded-xl border border-dashed border-border p-10 text-center">
              <p className="font-semibold">{unreadOnly ? 'ไม่มีการแจ้งเตือนที่ยังไม่อ่าน' : 'ยังไม่มีการแจ้งเตือน'}</p>
            </div>
          )}
          {groups.map(({ title, items }, index) => items.length > 0 && (
            <section key={title} className="mb-6">
              <h2 className="mb-2 text-sm font-semibold text-ink-soft">{title}</h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {items.map((item) => {
                  const Icon = iconFor(item.type);
                  const target = notificationTarget(item.link);
                  const Row = target ? 'button' : 'div';
                  return (
                    <li key={item.id}>
                      <Row onClick={target ? () => void open(item) : undefined} className={`flex w-full items-start gap-3 rounded-lg p-4 text-left [overflow-wrap:anywhere] ${target ? 'hover:bg-surface-muted' : ''}`}>
                        <span aria-hidden="true" className={`mt-2 h-2 w-2 shrink-0 rounded-full ${item.read ? 'bg-transparent' : 'bg-primary'}`} />
                        <Icon size={18} aria-hidden="true" className="mt-0.5 shrink-0 text-ink-soft" />
                        <span className="min-w-0 flex-1">
                          <span className="flex flex-wrap items-baseline justify-between gap-2">
                            <span className={`text-sm ${item.read ? 'font-medium' : 'font-semibold'}`}>{item.title}{!item.read && <span className="sr-only"> (ยังไม่อ่าน)</span>}</span>
                            <time dateTime={item.created_at} className="text-xs text-ink-soft">
                              {index !== 0 && dateFormat.format(new Date(item.created_at)) + ' · '}{timeFormat.format(new Date(item.created_at))}
                            </time>
                          </span>
                          <span className="mt-1 block text-sm text-ink-soft">{item.body}</span>
                        </span>
                        {!target && !item.read && <button type="button" className="text-xs font-medium text-primary" onClick={() => void open(item)}>ทำเครื่องหมายว่าอ่านแล้ว</button>}
                        {target && <ChevronRight size={16} aria-hidden="true" className="mt-1 shrink-0 text-ink-soft" />}
                      </Row>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))}
          {result && result.meta.total > PAGE_SIZE && (
            <nav aria-label="เลือกหน้า" className="mt-6 flex items-center justify-center gap-4 text-sm">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
              <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
            </nav>
          )}
        </section>
        <p className="mt-6 text-xs text-ink-soft">การแจ้งเตือนสำคัญจะถูกส่งทางอีเมลที่ลงทะเบียนไว้ด้วย <Link href="/account" className="text-primary hover:underline">ดูบัญชีของฉัน</Link></p>
      </div>
    </main>
  );
}
