'use client';

import { useId } from 'react';

/** Lifecycle `APPLICATION_LIMITS.REASON_MAX` — เหตุผลของ action ฝั่ง Admin */
export const LIFECYCLE_REASON_MAX = 2000;

/**
 * ช่องเหตุผลของ action Admin ฝั่ง Lifecycle — label แยกจากช่อง (`htmlFor`/`id` จาก `useId`), ตัวนับผูกด้วย `aria-describedby`,
 * `maxLength` ตาม Lifecycle (แบบเดียวกับ #106/#110)
 */
export function ReasonField({ label, value, onChange, required = false, rows = 3 }: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  required?: boolean;
  rows?: number;
}) {
  const id = useId();
  const counterId = `${id}-count`;
  return (
    <div className="text-sm">
      <label htmlFor={id} className="font-medium">
        {label} {required ? <span className="text-danger-text">(จำเป็น)</span> : <span className="font-normal text-ink-soft">(ไม่บังคับ)</span>}
      </label>
      <textarea id={id} value={value} onChange={(event) => onChange(event.target.value)} rows={rows}
        maxLength={LIFECYCLE_REASON_MAX} aria-describedby={counterId} aria-required={required || undefined}
        className="mt-1.5 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
      <p id={counterId} className="mt-1 text-right text-xs text-ink-soft">{value.length}/{LIFECYCLE_REASON_MAX}</p>
    </div>
  );
}
