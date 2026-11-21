import Link from 'next/link';
import type { JobCategory } from '@internpath/contracts';
import { CATEGORIES } from '@/lib/categories';

const icons: Record<JobCategory, React.ReactNode> = {
  TECH_IT: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>,
  BUSINESS_MARKETING: <><path d="M3 20h18" /><path d="M5 16l4-5 4 3 6-8" /></>,
  CORPORATE_SERVICES: <><rect x="6" y="3" width="12" height="18" rx="1" /><path d="M10 7h1M13 7h1M10 11h1M13 11h1M10 15h4" /></>,
};

/** Tile สีพื้น Parchment (DESIGN-apple: product-tile-parchment) ที่มีการ์ดสายงานสีขาวขอบบาง */
export function CategorySection() {
  return (
    <section aria-labelledby="categories-title" className="bg-surface-muted px-4 py-16 sm:py-20">
      <div className="mx-auto max-w-6xl text-center">
        <h2 id="categories-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-[1.1]">เลือกสายงานที่สนใจ</h2>
        <p className="mt-3 text-lg text-ink-soft">สามสายงานหลักบนแพลตฟอร์ม</p>
        <ul className="mt-10 grid gap-5 text-left sm:grid-cols-3">
          {CATEGORIES.map((category) => (
            <li key={category.id}>
              <Link
                href={`/jobs?category=${category.id}`}
                className="group flex h-full flex-col rounded-xl border border-border bg-surface p-6 hover:border-primary/40"
              >
                <svg aria-hidden viewBox="0 0 24 24" className="h-10 w-10 text-ink" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {icons[category.id]}
                </svg>
                <span className="mt-5 text-xl font-semibold">{category.label}</span>
                <span className="mt-1 text-sm text-ink-soft">{category.description}</span>
                <span className="mt-4 text-sm text-primary group-hover:underline">ดูงานในสายนี้ ›</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
