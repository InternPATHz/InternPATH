'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { NotificationItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';
import { notificationsApi } from '@/lib/notifications';

const PAGE_SIZE = 20;
const dateTimeFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' });

/** link มาจากเซิร์ฟเวอร์ แต่ต้องเป็นเส้นทางภายในเว็บเท่านั้น (ขึ้นต้น / และไม่ใช่ //) กัน open redirect */
const safeLink = (link?: string) => (link && link.startsWith('/') && !link.startsWith('//') ? link : undefined);

export function NotificationList() {
  const router = useRouter();
  const { request } = useAuth();
  const api = useMemo(() => notificationsApi(request), [request]);
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [result, setResult] = useState<Paginated<NotificationItem> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setResult(await api.list(page, PAGE_SIZE, unreadOnly)); setError(null); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'โหลดการแจ้งเตือนไม่สำเร็จ กรุณาลองใหม่'); }
  }, [api, page, unreadOnly]);

  useEffect(() => { setResult(null); void load(); }, [load]);

  const changed = () => window.dispatchEvent(new Event('internpath:notifications-changed'));

  async function open(item: NotificationItem) {
    if (!item.read) {
      try { await api.markRead(item.id); changed(); } catch { /* เปิดลิงก์ต่อได้แม้ทำเครื่องหมายไม่สำเร็จ */ }
    }
    const target = safeLink(item.link);
    if (target) router.push(target); else await load();
  }

  async function readAll() {
    setBusy(true);
    try { await api.markAllRead(); changed(); await load(); }
    catch (cause) { setError(cause instanceof ApiError ? cause.message : 'ทำเครื่องหมายไม่สำเร็จ กรุณาลองใหม่'); }
    finally { setBusy(false); }
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  const hasUnread = result?.data.some((item) => !item.read) ?? false;
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">การแจ้งเตือน</h1>
        </div>
        <button type="button" disabled={busy || !hasUnread} onClick={() => void readAll()} className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-50">
          ทำเครื่องหมายว่าอ่านทั้งหมด
        </button>
      </div>

      <div role="group" aria-label="กรองการแจ้งเตือน" className="mt-5 flex gap-2">
        {[['ทั้งหมด', false], ['ยังไม่อ่าน', true]].map(([label, value]) => (
          <button key={String(label)} type="button" aria-pressed={unreadOnly === value} onClick={() => { setUnreadOnly(value as boolean); setPage(1); }}
            className={`rounded-full border px-4 py-1.5 text-sm font-medium ${unreadOnly === value ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
            {label as string}
          </button>
        ))}
      </div>

      <section aria-busy={!result && !error} className="mt-5">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {result && result.data.length === 0 && (
          <div className="rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">{unreadOnly ? 'ไม่มีการแจ้งเตือนที่ยังไม่อ่าน' : 'ยังไม่มีการแจ้งเตือน'}</p>
          </div>
        )}
        {result && result.data.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {result.data.map((item) => (
              <li key={item.id}>
                <button type="button" onClick={() => void open(item)} className={`flex w-full items-start gap-3 p-4 text-left hover:bg-surface-muted ${item.read ? '' : 'bg-primary-soft'}`}>
                  <span aria-hidden="true" className={`mt-2 h-2.5 w-2.5 shrink-0 rounded-full ${item.read ? 'bg-transparent' : 'bg-primary'}`} />
                  <span className="min-w-0 flex-1">
                    <span className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className={`text-sm ${item.read ? 'font-medium' : 'font-semibold'}`}>{item.title}{!item.read && <span className="sr-only"> (ยังไม่อ่าน)</span>}</span>
                      <span className="text-xs text-ink-soft">{dateTimeFormat.format(new Date(item.created_at))}</span>
                    </span>
                    <span className="mt-1 block text-sm text-ink-soft">{item.body}</span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {result && result.meta.total > PAGE_SIZE && (
          <nav aria-label="เลือกหน้า" className="mt-6 flex items-center justify-center gap-4 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
            <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
          </nav>
        )}
      </section>
      <p className="mt-6 text-xs text-ink-soft">การแจ้งเตือนสำคัญจะถูกส่งทางอีเมลที่ลงทะเบียนไว้ด้วย <Link href="/account" className="text-primary hover:underline">ดูบัญชีของฉัน</Link></p>
    </main>
  );
}
