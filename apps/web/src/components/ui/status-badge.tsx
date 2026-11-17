import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

// ป้ายสถานะกลางของ UI Kit: สี/ตัวหนังสือมาจาก Design Token ใน tailwind.config.ts เท่านั้น
// ห้ามใช้โทนม่วง (accent) กับป้ายสถานะ — ม่วงสงวนไว้ให้ Featured / Urgent / Fast-Track (README หัวข้อ 8)

export type StatusTone = 'success' | 'warning' | 'danger' | 'info' | 'neutral';

const TONE_STYLE: Record<StatusTone, { badge: string; icon: string }> = {
  success: { badge: 'bg-success-soft text-success-text', icon: 'text-success' },
  warning: { badge: 'bg-warning-soft text-warning-text', icon: 'text-warning' },
  danger: { badge: 'bg-danger-soft text-danger-text', icon: 'text-danger' },
  info: { badge: 'bg-primary-soft text-primary-hover', icon: 'text-primary' },
  neutral: { badge: 'border border-border bg-surface-muted text-ink-soft', icon: 'text-neutral' },
};

export function StatusBadge({
  tone,
  icon: Icon,
  children,
  className = '',
}: {
  tone: StatusTone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  const style = TONE_STYLE[tone];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-1 text-sm font-semibold ${style.badge} ${className}`}
    >
      {Icon && <Icon aria-hidden="true" className={`h-4 w-4 shrink-0 ${style.icon}`} strokeWidth={2.5} />}
      {children}
    </span>
  );
}
