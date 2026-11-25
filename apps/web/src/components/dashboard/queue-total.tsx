'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';

export type QueueMetric = {
  title: string;
  href: string;
  paths: string[];
  linkLabel?: string;
  tone?: 'info' | 'danger';
};

export function QueueTotal({ metric, compact = false }: { metric: QueueMetric; compact?: boolean }) {
  const { request } = useAuth();
  const [revision, setRevision] = useState(0);
  const [value, setValue] = useState<number | 'error' | null>(null);
  useEffect(() => {
    let active = true;
    setValue(null);
    Promise.all(
      metric.paths.map((path) =>
        request<Paginated<unknown>>(path + (path.includes('?') ? '&' : '?') + 'page=1&page_size=1'),
      ),
    ).then(
      (results) => {
        if (active) setValue(results.reduce((n, result) => n + result.meta.total, 0));
      },
      () => {
        if (active) setValue('error');
      },
    );
    return () => {
      active = false;
    };
  }, [request, metric, revision]);
  if (compact)
    return (
      <div className="mt-2 flex items-center gap-2 text-sm">
        <Link href={metric.href} className="text-primary">
          {metric.title} · {value === 'error' ? '—' : (value ?? '…')} ›
        </Link>
        {value === 'error' && <button onClick={() => setRevision((r) => r + 1)}>โหลดจำนวนอีกครั้ง</button>}
      </div>
    );
  return (
    <li
      className={`min-w-0 rounded-xl border p-4 ${metric.tone === 'info' ? 'border-primary/20 bg-primary-soft' : metric.tone === 'danger' && typeof value === 'number' && value > 0 ? 'border-danger/20 bg-danger-soft' : 'border-border bg-surface'}`}
    >
      <Link className="block font-semibold hover:text-primary" href={metric.href}>
        {metric.title}
        {!metric.linkLabel && ' ›'}
        <span className="mt-2 block text-3xl tabular-nums" aria-live="polite">
          {value === 'error' ? '—' : (value ?? '…')}
        </span>
        {metric.linkLabel && (
          <span className="mt-1 block text-sm font-medium text-primary">{metric.linkLabel} ›</span>
        )}
      </Link>
      {value === 'error' && (
        <button className="mt-2 text-sm text-primary" onClick={() => setRevision((r) => r + 1)}>
          โหลดจำนวนอีกครั้ง
        </button>
      )}
    </li>
  );
}
