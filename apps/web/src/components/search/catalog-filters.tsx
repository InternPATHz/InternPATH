import { X } from 'lucide-react';
import { CATEGORIES } from '@/lib/categories';

export const filterPill = (active: boolean) =>
  `shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-sm lg:px-3 lg:py-1.5 ${active ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-border hover:border-primary'}`;

export function CategoryButtons({ category, onChange }: {
  category?: string; onChange: (category?: string) => void;
}) {
  return [{ id: '', label: 'ทุกสายงาน' }, ...CATEGORIES].map(({ id, label }) => (
    <button key={id} type="button" aria-pressed={id === (category ?? '')} className={filterPill(id === (category ?? ''))}
      onClick={() => onChange(id || undefined)}>{label}</button>
  ));
}

export const filterRow = 'lg:grid lg:grid-cols-[7.5rem_minmax(0,1fr)] lg:items-center lg:gap-3';
export const filterLabel = 'hidden text-sm font-semibold text-ink-soft lg:block';

export function AppliedFilters({ filters, onClear }: {
  filters: Array<{ key: string; label?: string; remove: () => void }>; onClear: () => void;
}) {
  if (!filters.length) return null;
  return (
    <div role="group" aria-label="ตัวกรองที่ใช้อยู่" className="flex min-w-0 flex-wrap items-center gap-2">
      {filters.map(({ key, label, remove }) => (
        <button key={key} type="button" onClick={remove} aria-label={`เอาตัวกรอง ${label} ออก`}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-sm hover:border-primary lg:px-2.5 lg:py-1 lg:text-xs">
          <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
          <X size={13} aria-hidden="true" className="shrink-0" />
        </button>
      ))}
      <button type="button" onClick={onClear} className="text-sm font-medium text-primary hover:underline">
        <span className="lg:hidden">ล้างทั้งหมด</span><span className="hidden lg:inline">ล้างตัวกรอง</span>
      </button>
    </div>
  );
}
