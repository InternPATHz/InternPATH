'use client';

import Link from 'next/link';
import { useCatalogFilters } from '@/components/search/use-catalog-filters';
import { useEffect, useState } from 'react';
import type { DirectoryCompanyListItem, Paginated } from '@internpath/contracts';
import { AppliedFilters, CategoryButtons, filterLabel, filterRow } from '@/components/search/catalog-filters';
import { catalogHref, filterHref } from '@/lib/catalog-navigation';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { RatingSummary } from '@/components/ui/rating';
import { ApiError } from '@/lib/api';
import { CATEGORIES } from '@/lib/categories';
import { listCompanies } from '@/lib/directory';

const PAGE_SIZE = 12;

export function CompanyList() {
  const { pathname, searchParams, update } = useCatalogFilters();
  const q = searchParams.get('q')?.trim() ?? '';
  const partner = searchParams.get('partner') === 'true';
  const categoryParam = searchParams.get('category');
  const category = CATEGORIES.find((item) => item.id === categoryParam)?.id;
  const pageParam = Number(searchParams.get('page'));
  const page = Number.isInteger(pageParam) && pageParam >= 1 ? pageParam : 1;

  const [text, setText] = useState(q);
  const [result, setResult] = useState<Paginated<DirectoryCompanyListItem> | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setText(q), [q]);

  useEffect(() => {
    let cancelled = false;
    setResult(null);
    setError(null);
    listCompanies({ q: q || undefined, category, partner }, page, PAGE_SIZE).then(
      (data) => { if (!cancelled) setResult(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดรายชื่อบริษัทไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [q, category, partner, page]);

  const filters = [
    { key: 'q', label: q, remove: () => update({ q: undefined }) },
    { key: 'category', label: CATEGORIES.find((item) => item.id === category)?.label, remove: () => update({ category: undefined }) },
    { key: 'partner', label: partner ? 'University Partner' : undefined, remove: () => update({ partner: undefined }) },
  ].filter((filter) => filter.label);
  function clearFilters() { update({ q: undefined, category: undefined, partner: undefined }); }

  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="bg-surface-muted">
      <nav aria-label="เมนูบริษัทและรีวิว" className="frosted sticky top-[3.25rem] z-20 hidden border-b border-border lg:block">
        <div className="mx-auto flex min-h-[52px] max-w-6xl items-center justify-between gap-6 px-6 py-2">
          <span className="text-xl font-semibold">บริษัทและรีวิว</span>
          <div className="flex items-center gap-5 text-xs text-ink/80">
            <Link href={filterHref(pathname, searchParams.toString(), { partner: undefined })} aria-current={!partner ? 'page' : undefined}
              className="py-2 hover:text-primary aria-[current=page]:text-ink-soft">บริษัททั้งหมด</Link>
            <Link href={filterHref(pathname, searchParams.toString(), { partner: 'true' })} aria-current={partner ? 'page' : undefined}
              className="py-2 hover:text-primary aria-[current=page]:text-ink-soft">University Partner</Link>
            <Link href="/jobs" className="py-2 hover:text-primary">ค้นหางาน</Link>
          </div>
        </div>
      </nav>
      <div className="mx-auto max-w-6xl px-4 pt-10 pb-5 sm:px-6 lg:py-7">
        <h1 className="text-4xl font-semibold">บริษัทและรีวิว</h1>
        <p className="mt-2 text-sm text-ink-soft">ดูข้อมูลบริษัทที่ผ่านการรับรองและรีวิวจากผู้ฝึกงานจริง</p>

        <form role="search" onSubmit={(event) => { event.preventDefault(); update({ q: text.trim() || undefined }); }}
          className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="flex-1 text-sm">
            <label htmlFor="company-q" className="mb-1 block text-xs font-medium text-ink-soft">ชื่อบริษัท</label>
            <input id="company-q" type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="ค้นหาชื่อบริษัท"
              className="w-full rounded-full border border-border bg-surface px-5 py-2.5 text-base outline-none focus:border-primary" />
          </div>
          <button type="submit" className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover">ค้นหา</button>
        </form>

      </div>
      <div className="mx-auto max-w-6xl px-4 sm:px-6 lg:max-w-none lg:border-y lg:border-border lg:bg-surface lg:px-0">
        <div className="flex gap-2 overflow-x-auto rounded-xl bg-surface p-3 lg:mx-auto lg:block lg:max-w-6xl lg:space-y-2 lg:overflow-visible lg:rounded-none lg:px-6" role="group" aria-label="ตัวกรองบริษัท">
          <div className={`contents ${filterRow}`}>
            <span className={filterLabel}>สายงาน</span>
            <div role="group" aria-label="สายงาน" className="contents lg:flex lg:flex-wrap lg:gap-2 lg:p-1">
              <CategoryButtons category={category} onChange={(id) => update({ category: id })} />
            </div>
          </div>
          <div className={`contents ${filterRow}`}>
            <span className={filterLabel}>ประเภทบริษัท</span>
            <label className="hidden w-fit items-center gap-2 p-1 text-sm lg:flex">
              <input type="checkbox" checked={partner} className="accent-primary"
                onChange={(event) => update({ partner: event.target.checked ? 'true' : undefined })} />
              เฉพาะ University Partner
            </label>
            <button type="button" aria-pressed={partner}
              className={`shrink-0 rounded-full border px-4 py-2 text-sm lg:hidden ${partner ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:border-primary'}`}
              onClick={() => update({ partner: partner ? undefined : 'true' })}>เฉพาะ University Partner</button>
          </div>
        </div>
      </div>
      <div className="mx-auto max-w-6xl px-4 pb-10 sm:px-6">
        <section aria-busy={!result && !error} className="mt-6">
          {error && <Notice tone="error">{error}</Notice>}
          {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
          <div className="flex flex-wrap items-center gap-3">
            {result && <h2 className="text-sm text-ink-soft lg:text-xl lg:font-semibold lg:text-ink">พบ {result.meta.total} บริษัท</h2>}
            <div className="hidden min-w-0 lg:block"><AppliedFilters filters={filters} onClear={clearFilters} /></div>
          </div>
          {result && result.data.length === 0 && (
            <div className="mt-4 rounded-xl border border-dashed border-border p-10 text-center">
              <p className="font-semibold">ไม่พบบริษัทที่ตรงกับเงื่อนไข</p>
              <p className="mt-1 text-sm text-ink-soft">ลองค้นด้วยชื่อที่สั้นลง หรือยกเลิกตัวกรอง</p>
              {filters.length > 0 && <button type="button" onClick={clearFilters}
                className="mt-3 hidden rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold text-primary hover:border-primary lg:inline-block">ล้างตัวกรอง</button>}
            </div>
          )}
          {result && result.data.length > 0 && (
            <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              {result.data.map((company) => (
                <li key={company.id} className="flex min-w-0 flex-col rounded-xl border border-border bg-surface p-5 [overflow-wrap:anywhere]">
                  <div className="grid min-h-40 place-items-center rounded-lg bg-surface-muted">
                    <Avatar name={company.name} src={company.logo_url} size="lg" />
                  </div>
                  <h3 className="mt-4 text-lg font-semibold">{company.name}</h3>
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    {company.university_partner && <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">University Partner</span>}
                  </div>
                  <div className="mt-3"><RatingSummary average={company.rating_avg} count={company.review_count} /></div>
                  <Link href={catalogHref('/companies', searchParams, company.id)} className="mt-4 inline-block self-start text-sm font-semibold text-primary hover:underline">ดูบริษัทและรีวิว ›</Link>
                </li>
              ))}
            </ul>
          )}
          {result && result.meta.total > PAGE_SIZE && (
            <nav aria-label="เลือกหน้า" className="mt-8 flex items-center justify-center gap-4 text-sm">
              <button type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, true)}
                className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
              <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
              <button type="button" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) }, true)}
                className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
            </nav>
          )}
        </section>
      </div>
      <aside className="bg-tile px-4 py-12 text-white sm:px-6">
        <div className="mx-auto max-w-6xl">
          <h2 className="text-2xl font-semibold">รีวิวมาจากผู้ฝึกงานจริง</h2>
          <p className="mt-2 text-white/75">ทุกรีวิวแสดงผลการฝึกของผู้เขียนประกอบ เพื่อให้คุณเห็นประสบการณ์จากทั้งผู้ที่ผ่านและผู้ที่ไม่ผ่านการฝึกงาน</p>
        </div>
      </aside>
    </main>
  );
}
