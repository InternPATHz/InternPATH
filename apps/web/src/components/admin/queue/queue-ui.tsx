import type { QueueItemStatus, QueueItemSummary, QueueItemType } from '@internpath/contracts';
import type { ReactNode } from 'react';

export const TYPE_LABEL: Record<QueueItemType, string> = {
  JOB_REVIEW: 'ตรวจประกาศ',
  COMPANY_ACCOUNT: 'ธงบริษัท',
  JOB_REPORT: 'รายงานประกาศ',
  REVIEW_REPORT: 'รายงานรีวิว',
};

export const STATUS_LABEL: Record<QueueItemStatus, string> = { OPEN: 'รอตรวจ', IN_REVIEW: 'กำลังตรวจ', RESOLVED: 'ปิดแล้ว' };

export function Badge({ children, className }: { children: ReactNode; className: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function ItemBadges({ item }: { item: Pick<QueueItemSummary, 'overdue' | 'priority'> }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.overdue && <Badge className="bg-danger-soft text-danger-text">OVERDUE</Badge>}
      {item.priority === 'FAST_TRACK' && <Badge className="bg-accent-soft text-accent-text">Fast-Track</Badge>}
    </div>
  );
}

const formatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}
