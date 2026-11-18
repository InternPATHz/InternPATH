import { Star } from 'lucide-react';

/** ดาวคะแนน 1-5 (เต็มดวง/ว่าง ปัดตามค่าเฉลี่ย) — ข้อความอ่านออกเสียงได้ ไม่พึ่งสีอย่างเดียว */
export function Stars({ value, className = '' }: { value: number; className?: string }) {
  const filled = Math.round(Math.max(0, Math.min(5, value)));
  return (
    <span role="img" aria-label={`${value.toFixed(1)} จาก 5 ดาว`} className={`inline-flex items-center gap-0.5 ${className}`}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Star key={n} aria-hidden="true" className={`h-4 w-4 ${n <= filled ? 'fill-warning text-warning' : 'text-border'}`} strokeWidth={2} />
      ))}
    </span>
  );
}

/** "4.6 (12 รีวิว)" หรือ "ยังไม่มีรีวิว" */
export function RatingSummary({ average, count }: { average: number; count: number }) {
  if (count <= 0) return <span className="text-sm text-ink-soft">ยังไม่มีรีวิว</span>;
  return (
    <span className="inline-flex items-center gap-2 text-sm">
      <Stars value={average} />
      <span className="text-ink-soft">{average.toFixed(1)} ({count} รีวิว)</span>
    </span>
  );
}
