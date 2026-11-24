'use client';

import { useId } from 'react';

/**
 * ช่องกรองและกล่องข้อความที่หน้ารายการของ Admin ใช้ร่วมกัน
 * label อยู่ข้างช่องและผูกด้วย `htmlFor`/`id` — ห้ามเอา label ครอบ `<select>` เพราะชื่อช่องที่เครื่องอ่านหน้าจอได้จะพ่วงข้อความตัวเลือกทุกตัวมาด้วย
 */
export function FilterSelect({ label, value, onChange, options }: {
  label: string; value: string; onChange: (value: string) => void; options: Array<[string, string]>;
}) {
  const id = useId();
  return (
    <div className="min-w-0 max-w-full text-sm">
      <label htmlFor={id} className="mb-1 block text-xs font-medium text-ink-soft">{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}
        className="max-w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm outline-none focus:border-primary">
        {options.map(([optionValue, text]) => <option key={optionValue} value={optionValue}>{text}</option>)}
      </select>
    </div>
  );
}

export function Notice({ tone, children }: { tone: 'error' | 'success'; children: React.ReactNode }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'}
      className={`rounded-lg px-4 py-3 text-sm ${tone === 'error' ? 'bg-danger-soft text-danger-text' : 'bg-success-soft text-success-text'}`}>
      {children}
    </p>
  );
}
