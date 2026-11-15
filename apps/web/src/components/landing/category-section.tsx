import Link from 'next/link';
import type { JobCategory } from '@internpath/contracts';
import { CATEGORIES } from '@/lib/mock-landing';

const icons: Record<JobCategory, React.ReactNode> = {
  TECH_IT: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>,
  BUSINESS_MARKETING: <><path d="M3 20h18" /><path d="M5 16l4-5 4 3 6-8" /></>,
  CORPORATE_SERVICES: <><rect x="6" y="3" width="12" height="18" rx="1" /><path d="M10 7h1M13 7h1M10 11h1M13 11h1M10 15h4" /></>,
};

export function CategorySection() {
  return (
    <section aria-labelledby="categories-title" className="mt-12">
      <h2 id="categories-title" className="text-xl font-bold">เลือกสายงานที่สนใจ</h2>
      <p className="mt-1 text-sm text-ink-soft">สามหมวดงานในระบบ</p>
      <ul className="mt-4 grid gap-4 sm:grid-cols-3">
        {CATEGORIES.map((category) => (
          <li key={category.id}>
            <Link
              href={`/jobs?category=${category.id}`}
              className="flex h-full flex-col items-center rounded-xl border border-border bg-surface p-6 text-center shadow-sm hover:border-primary"
            >
              <svg aria-hidden viewBox="0 0 24 24" className="h-12 w-12 text-primary" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                {icons[category.id]}
              </svg>
              <span className="mt-3 font-semibold">{category.label}</span>
              <span className="mt-1 text-xs text-ink-soft">{category.description}</span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
