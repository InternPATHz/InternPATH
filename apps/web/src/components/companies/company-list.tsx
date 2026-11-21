'use client';

import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DirectoryCompanyListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { RatingSummary } from '@/components/ui/rating';
import { ApiError } from '@/lib/api';
import { listCompanies } from '@/lib/directory';

const PAGE_SIZE = 12;

export function CompanyList() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { request } = useAuth();
  const q = searchParams.get('q')?.trim() ?? '';
  const partner = searchParams.get('partner') === 'true';
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
    // เส้นทางสาธารณะ (ไม่ต้องล็อกอิน) — `request` ส่ง token เมื่อมี (ดูหมายเหตุใน lib/directory.ts เรื่องฉบับชั่วคราวของ Identity)
    listCompanies(request, { q: q || undefined, partner }, page, PAGE_SIZE).then(
      (data) => { if (!cancelled) setResult(data); },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดรายชื่อบริษัทไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, q, partner, page]);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) { if (value) next.set(name, value); else next.delete(name); }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">บริษัทและรีวิว</h1>
      <p className="mt-2 text-sm text-ink-soft">ดูข้อมูลบริษัทที่ผ่านการรับรองและรีวิวจากผู้ฝึกงานจริง</p>

      <form role="search" onSubmit={(event) => { event.preventDefault(); update({ q: text.trim() || undefined }); }}
        className="mt-6 flex flex-col gap-3 rounded-xl bg-surface-muted p-4 sm:flex-row sm:items-end">
        <label className="flex-1 text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">ชื่อบริษัท</span>
          <input type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="ค้นหาชื่อบริษัท"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary" />
        </label>
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input type="checkbox" checked={partner} onChange={(event) => update({ partner: event.target.checked ? 'true' : undefined })} className="h-4 w-4 accent-primary" />
          เฉพาะ University Partner
        </label>
        <button type="submit" className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover">ค้นหา</button>
      </form>

      <section aria-busy={!result && !error} className="mt-6">
        {error && <Notice tone="error">{error}</Notice>}
        {!result && !error && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {result && <h2 className="text-sm text-ink-soft">พบ {result.meta.total} บริษัท</h2>}
        {result && result.data.length === 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">ไม่พบบริษัทที่ตรงกับเงื่อนไข</p>
            <p className="mt-1 text-sm text-ink-soft">ลองค้นด้วยชื่อที่สั้นลง หรือยกเลิกตัวกรอง</p>
          </div>
        )}
        {result && result.data.length > 0 && (
          <ul className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {result.data.map((company) => (
              <li key={company.id} className="flex flex-col rounded-xl border border-border bg-surface p-5">
                <div className="flex items-center gap-3">
                  <Avatar name={company.name} src={company.logo_url} size="md" />
                  <h3 className="min-w-0 text-lg font-semibold">{company.name}</h3>
                </div>
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">Verified by Platform</span>
                  {company.university_partner && <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">University Partner</span>}
                </div>
                <div className="mt-3"><RatingSummary average={company.rating_avg} count={company.review_count} /></div>
                <Link href={`/companies/item?id=${company.id}`} className="mt-4 inline-block self-start rounded-full bg-primary-soft px-4 py-2 text-sm font-semibold text-primary hover:bg-primary hover:text-white">ดูบริษัทและรีวิว</Link>
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
    </main>
  );
}
