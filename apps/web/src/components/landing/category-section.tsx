'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { JobCategory, Paginated, SearchJobItem } from '@internpath/contracts';
import { CATEGORIES } from '@/lib/categories';
import { apiRequest } from '@/lib/api';

const icons: Record<JobCategory, React.ReactNode> = {
  TECH_IT: <><rect x="4" y="5" width="16" height="11" rx="1.5" /><path d="M2 19h20" /></>,
  BUSINESS_MARKETING: <><path d="M3 20h18" /><path d="M5 16l4-5 4 3 6-8" /></>,
  CORPORATE_SERVICES: <><rect x="6" y="3" width="12" height="18" rx="1" /><path d="M10 7h1M13 7h1M10 11h1M13 11h1M10 15h4" /></>,
};

/** Tile เข้มสำหรับเลือกสายงาน */
export function CategorySection() {
  const [counts, setCounts] = useState<Partial<Record<JobCategory, number>>>({});

  useEffect(() => {
    let active = true;
    for (const { id } of CATEGORIES) {
      const query = new URLSearchParams({ category: id, page_size: '1' });
      void apiRequest<Paginated<SearchJobItem>>(`/search/jobs?${query}`).then(
        ({ meta }) => { if (active) setCounts((current) => ({ ...current, [id]: meta.total })); },
        () => undefined,
      );
    }
    return () => { active = false; };
  }, []);

  return (
    <section aria-labelledby="categories-title" className="bg-tile px-4 py-16 text-white sm:py-20 lg:px-6 lg:py-6">
      <div className="mx-auto max-w-6xl text-center">
        <h2 id="categories-title" className="text-3xl font-semibold sm:text-[40px] sm:leading-[1.1] lg:text-xl">เลือกสายงานที่ใช่สำหรับคุณ</h2>
        <p className="mt-3 text-lg text-white/75 lg:hidden">สามสายงานหลักบนแพลตฟอร์ม</p>
        <ul className="mt-10 grid gap-5 text-left sm:grid-cols-3 lg:mx-auto lg:mt-4 lg:max-w-[1104px] lg:gap-4">
          {CATEGORIES.map((category) => (
            <li key={category.id}>
              <Link
                href={`/jobs?category=${category.id}`}
                className="group flex h-full flex-col rounded-xl border border-white/10 bg-white/5 p-6 hover:border-primary-on-dark lg:flex-row lg:items-baseline lg:justify-between lg:gap-2 lg:rounded-lg lg:px-4 lg:py-3"
              >
                <svg aria-hidden viewBox="0 0 24 24" className="h-10 w-10 text-white lg:hidden" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  {icons[category.id]}
                </svg>
                <span className="mt-5 text-xl font-semibold lg:mt-0 lg:text-sm">{category.label}</span>
                <span className="mt-1 text-sm text-white/75 lg:hidden">{category.description}</span>
                {counts[category.id] !== undefined && (
                  <span className="mt-2 text-sm text-white/75 lg:mt-0 lg:whitespace-nowrap lg:text-xs">
                    {counts[category.id]} ประกาศ<span className="ml-1 hidden lg:inline" aria-hidden="true">›</span>
                  </span>
                )}
                <span className="mt-4 text-sm text-primary-on-dark group-hover:underline lg:hidden">ดูงานในสายนี้ ›</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
