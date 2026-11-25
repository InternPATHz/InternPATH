'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { DirectoryCompanyDetail, Paginated, PublicReviewItem, SearchJobItem } from '@internpath/contracts';
import { Notice } from '@/components/admin/filter-fields';
import { OUTCOME, reviewerLabel } from '@/components/companies/review-display';
import { ReportPanel } from '@/components/reports/report-panel';
import { Avatar } from '@/components/ui/avatar';
import { RatingSummary, Stars } from '@/components/ui/rating';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError, apiRequest } from '@/lib/api';
import { allowanceLabel } from '@/lib/allowance';
import { externalHref } from '@/lib/external-url';

const PAGE_SIZE = 10;

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });

/**
 * หน้า Public: ข้อมูลบริษัท (§4.4) และรีวิวที่เผยแพร่ (§7.6) อ่านได้โดยไม่ล็อกอิน ⇒ เรียก `apiRequest` ไม่แนบ token
 * (`useAuth().request` refresh session ก่อนเสมอ ผู้เยี่ยมชมจะได้ 401) • การรายงานรีวิวใน `ReportPanel` ยังต้องล็อกอินตามเดิม
 */
export function CompanyDetail() {
  const id = useSearchParams().get('id') ?? '';
  const [company, setCompany] = useState<DirectoryCompanyDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Paginated<PublicReviewItem> | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [openJobs, setOpenJobs] = useState<Paginated<SearchJobItem> | null>(null);
  const [jobsUnavailable, setJobsUnavailable] = useState(false);

  useEffect(() => {
    if (!id) { setMissing(true); return; }
    let cancelled = false;
    setCompany(null);
    setMissing(false);
    setError(null);
    apiRequest<DirectoryCompanyDetail>(`/directory/companies/${encodeURIComponent(id)}`).then(
      (data) => { if (!cancelled) setCompany(data); },
      (cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 400)) setMissing(true);
        else setError(cause instanceof ApiError ? cause.message : 'โหลดข้อมูลบริษัทไม่สำเร็จ กรุณาลองใหม่');
      },
    );
    return () => { cancelled = true; };
  }, [id]);

  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    setReviews(null);
    setReviewError(null);
    apiRequest<Paginated<PublicReviewItem>>(`/companies/${encodeURIComponent(company.id)}/reviews?page=${page}&page_size=${PAGE_SIZE}`).then(
      (data) => { if (!cancelled) setReviews(data); },
      (cause) => { if (!cancelled) setReviewError(cause instanceof ApiError ? cause.message : 'โหลดรีวิวไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [company, page]);

  const companyId = company?.id;
  useEffect(() => {
    if (!companyId) return;
    let cancelled = false;
    setOpenJobs(null);
    setJobsUnavailable(false);
    const query = new URLSearchParams({ company_id: companyId, page_size: '3' });
    apiRequest<Paginated<SearchJobItem>>(`/search/jobs?${query}`).then(
      (data) => { if (!cancelled) setOpenJobs(data); },
      () => { if (!cancelled) setJobsUnavailable(true); },
    );
    return () => { cancelled = true; };
  }, [companyId]);

  if (missing || error) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">{missing ? 'ไม่พบบริษัทนี้' : 'โหลดข้อมูลไม่สำเร็จ'}</h1>
        <p className="mt-2 text-sm text-ink-soft">{missing ? 'บริษัทอาจยังไม่ผ่านการรับรองหรือถูกระงับ' : error}</p>
        <Link href="/companies" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปรายชื่อบริษัท</Link>
      </main>
    );
  }
  if (!company) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const totalPages = reviews ? Math.max(1, Math.ceil(reviews.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-5xl px-4 pb-10 sm:px-6">
      <div className="frosted sticky top-12 z-20 -mx-4 flex min-w-0 items-center justify-between gap-3 border-b border-border px-4 py-2 sm:-mx-6 sm:px-6">
        <div className="min-w-0">
          <Link href="/companies" className="text-xs font-medium text-primary hover:underline">← บริษัทและรีวิว</Link>
          <p className="truncate text-sm font-semibold">{company.name}</p>
        </div>
        <Link href={`/jobs?company_id=${company.id}`} className="shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover">ดูประกาศงาน</Link>
      </div>

      <header className="mt-4 grid grid-cols-1 justify-items-center gap-4 [overflow-wrap:anywhere] bg-surface py-12 text-center">
        <Avatar name={company.name} src={company.logo_url} size="lg" />
        <div className="min-w-0">
          <h1 className="text-4xl font-semibold sm:text-5xl">{company.name}</h1>
          <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
            <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">Verified by Platform</span>
            {company.university_partner && <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">University Partner</span>}
          </div>

        </div>
      </header>

      <div className="flex flex-wrap items-center justify-center gap-4 pb-10 text-sm">
        <Link href={`/jobs?company_id=${company.id}`} className="rounded-full bg-primary px-5 py-2.5 font-semibold text-white hover:bg-primary-hover">ดูประกาศงานของบริษัท</Link>
        {externalHref(company.website) && <a href={externalHref(company.website)} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">เว็บไซต์บริษัท</a>}
      </div>

      <section aria-label="สรุปคะแนนรีวิว" className="rounded-xl bg-surface-muted p-6">
        <h2 className="text-xl font-semibold">สรุปคะแนนรีวิว</h2>
        <div className="mt-2"><RatingSummary average={company.rating_avg} count={company.review_count} /></div>
      </section>

      <section aria-labelledby="company-jobs-title" className="mt-10">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="company-jobs-title" className="text-xl font-semibold">ประกาศที่เปิดรับ</h2>
          <Link href={`/jobs?company_id=${company.id}`} className="text-sm font-medium text-primary hover:underline">ดูประกาศทั้งหมด ›</Link>
        </div>
        {jobsUnavailable && <p className="mt-3 text-sm text-ink-soft">โหลดประกาศไม่สำเร็จ</p>}
        {!openJobs && !jobsUnavailable && <p role="status" className="mt-3 text-sm text-ink-soft">กำลังโหลดประกาศ…</p>}
        {openJobs?.data.length === 0 && <p className="mt-3 text-sm text-ink-soft">ยังไม่มีประกาศที่เปิดรับ</p>}
        {!!openJobs?.data.length && (
          <ul className="mt-4 grid gap-3 sm:grid-cols-3">
            {openJobs.data.map((job) => (
              <li key={job.id}>
                <Link href={`/jobs/item?id=${job.id}`} className="block h-full rounded-xl bg-surface-muted p-4 [overflow-wrap:anywhere] hover:text-primary">
                  <p className="font-semibold">{job.job_title}</p>
                  <p className="mt-1 text-sm text-ink-soft">{allowanceLabel(job.allowance)} · ปิดรับ {dateFormat.format(new Date(job.application_deadline))}</p>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="reviews-title" className="mt-10">
        <h2 id="reviews-title" className="text-xl font-semibold">รีวิวจากผู้ฝึกงาน</h2>
        <p className="mt-1 text-sm text-ink-soft">รีวิวทุกรายการแสดงผลการฝึกของผู้เขียนคู่กันเสมอ</p>

        {reviewError && <div className="mt-4"><Notice tone="error">{reviewError}</Notice></div>}
        {!reviews && !reviewError && <p className="mt-4 text-sm text-ink-soft">กำลังโหลดรีวิว…</p>}
        {reviews && reviews.data.length === 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-ink-soft">ยังไม่มีรีวิวที่เผยแพร่</div>
        )}
        {reviews && reviews.data.length > 0 && (
          <ul className="mt-4 space-y-4">
            {reviews.data.map((review) => {
              const outcome = OUTCOME[review.outcome_label];
              return (
                <li key={review.id} className="rounded-xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Stars value={review.rating} />
                    <StatusBadge tone={outcome.tone} icon={outcome.icon}>{outcome.label}</StatusBadge>
                  </div>
                  <p className="mt-2 text-xs text-ink-soft">{reviewerLabel(review)} · {dateFormat.format(new Date(review.published_at))}</p>
                  {review.title && <h3 className="mt-3 font-semibold">{review.title}</h3>}
                  <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{review.body}</p>
                  {review.reply && (
                    <div className="mt-4 rounded-lg bg-surface-muted p-3 text-sm">
                      <p className="text-xs font-medium text-ink-soft">คำตอบจากบริษัท · {dateFormat.format(new Date(review.reply.created_at))}</p>
                      <p className="mt-1 whitespace-pre-line">{review.reply.body}</p>
                    </div>
                  )}
                  <div className="mt-4"><ReportPanel kind="review" targetId={review.id} /></div>
                </li>
              );
            })}
          </ul>
        )}
        {reviews && reviews.meta.total > PAGE_SIZE && (
          <nav aria-label="เลือกหน้ารีวิว" className="mt-6 flex items-center justify-center gap-4 text-sm">
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
            <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
          </nav>
        )}
      </section>
    </main>
  );
}
