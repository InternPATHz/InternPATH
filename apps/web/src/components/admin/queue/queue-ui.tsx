import type { QueueItemStatus, QueueItemSummary, QueueItemType, RiskLevel } from '@internpath/contracts';
import type { ReactNode } from 'react';

export const TYPE_LABEL: Record<QueueItemType, string> = {
  JOB_REVIEW: 'ตรวจประกาศ',
  JOB_APPEAL: 'อุทธรณ์ประกาศ',
  COMPANY_ACCOUNT: 'ธงบริษัท',
  JOB_REPORT: 'รายงานประกาศ',
  REVIEW_HELD: 'รีวิวที่ถูกพัก',
  REVIEW_REPORT: 'รายงานรีวิว',
};

export const STATUS_LABEL: Record<QueueItemStatus, string> = { OPEN: 'รอตรวจ', IN_REVIEW: 'กำลังตรวจ', RESOLVED: 'ปิดแล้ว' };

/** ไฟจราจรตาม README §8: เขียว = Low, เหลือง = Medium, แดง = High; ไม่มีระดับความเสี่ยง (รายงาน/ธง/รีวิว) = เทา */
const RISK: Record<RiskLevel, { label: string; stripe: string; badge: string }> = {
  LOW: { label: 'ความเสี่ยงต่ำ', stripe: 'border-l-success', badge: 'bg-success-soft text-success-text' },
  MEDIUM: { label: 'ความเสี่ยงกลาง', stripe: 'border-l-warning', badge: 'bg-warning-soft text-warning-text' },
  HIGH: { label: 'ความเสี่ยงสูง', stripe: 'border-l-danger', badge: 'bg-danger-soft text-danger-text' },
};
const NO_RISK = { label: 'ไม่มีคะแนนความเสี่ยง', stripe: 'border-l-neutral', badge: 'bg-surface-muted text-ink-soft' };

export const riskStyle = (level: RiskLevel | null) => (level ? RISK[level] : NO_RISK);

export function Badge({ children, className }: { children: ReactNode; className: string }) {
  return <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${className}`}>{children}</span>;
}

export function ItemBadges({ item }: { item: Pick<QueueItemSummary, 'risk_level' | 'is_appeal' | 'overdue' | 'priority'> }) {
  const risk = riskStyle(item.risk_level);
  return (
    <div className="flex flex-wrap gap-1.5">
      {item.risk_level && <Badge className={risk.badge}>{risk.label}</Badge>}
      {item.is_appeal && <Badge className="bg-warning-soft text-warning-text">APPEAL</Badge>}
      {item.overdue && <Badge className="bg-danger-soft text-danger-text">OVERDUE</Badge>}
      {item.priority === 'FAST_TRACK' && <Badge className="bg-accent-soft text-accent">Fast-Track</Badge>}
    </div>
  );
}

const formatter = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
export function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '—' : formatter.format(date);
}
