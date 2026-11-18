'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { CircleCheck, CircleX, Clock5 } from 'lucide-react';
import type { DirectoryCompanyDetail, Paginated, PublicReviewItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ReportPanel } from '@/components/reports/report-panel';
import { Avatar } from '@/components/ui/avatar';
import { RatingSummary, Stars } from '@/components/ui/rating';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 10;

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });

// ป้ายผลการฝึกที่แสดงคู่รีวิวเสมอ (README 5.5 — กัน Review Silencing: รีวิวของผู้ที่ไม่ผ่านต้องไม่ถูกซ่อนหรือดูเหมือนผ่าน)
const OUTCOME = {
  PASS: { label: 'ผ่านการฝึกงาน', tone: 'success', icon: CircleCheck },
  FAIL: { label: 'ไม่ผ่านการประเมิน', tone: 'danger', icon: CircleX },
  TERMINATED: { label: 'ยุติการฝึกก่อนกำหนด', tone: 'neutral', icon: Clock5 },
  NO_EVALUATION: { label: 'บริษัทไม่ได้ประเมิน', tone: 'neutral', icon: Clock5 },
} as const;

function reviewerLabel(review: PublicReviewItem): string {
  if (review.reviewer_name) return review.reviewer_name;
  const parts = [review.display_major, review.display_year !== undefined ? `ชั้นปี ${review.display_year}` : undefined].filter(Boolean);
  return parts.length > 0 ? `ผู้ฝึกงานไม่ระบุชื่อ · ${parts.join(' ')}` : 'ผู้ฝึกงานไม่ระบุชื่อ';
}

export function CompanyDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const [company, setCompany] = useState<DirectoryCompanyDetail | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reviews, setReviews] = useState<Paginated<PublicReviewItem> | null>(null);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    if (!id) { setMissing(true); return; }
    let cancelled = false;
    setCompany(null);
    setMissing(false);
    setError(null);
    request<DirectoryCompanyDetail>(`/directory/companies/${encodeURIComponent(id)}`).then(
      (data) => { if (!cancelled) setCompany(data); },
      (cause) => {
        if (cancelled) return;
        if (cause instanceof ApiError && (cause.status === 404 || cause.status === 400)) setMissing(true);
        else setError(cause instanceof ApiError ? cause.message : 'โหลดข้อมูลบริษัทไม่สำเร็จ กรุณาลองใหม่');
      },
    );
    return () => { cancelled = true; };
  }, [request, id]);

  useEffect(() => {
    if (!company) return;
    let cancelled = false;
    setReviews(null);
    setReviewError(null);
    request<Paginated<PublicReviewItem>>(`/companies/${encodeURIComponent(company.id)}/reviews?page=${page}&page_size=${PAGE_SIZE}`).then(
      (data) => { if (!cancelled) setReviews(data); },
      (cause) => { if (!cancelled) setReviewError(cause instanceof ApiError ? cause.message : 'โหลดรีวิวไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, company, page]);

  if (missing || error) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-bold">{missing ? 'ไม่พบบริษัทนี้' : 'โหลดข้อมูลไม่สำเร็จ'}</h1>
        <p className="mt-2 text-sm text-ink-soft">{missing ? 'บริษัทอาจยังไม่ผ่านการรับรองหรือถูกระงับ' : error}</p>
        <Link href="/companies" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปรายชื่อบริษัท</Link>
      </main>
    );
  }
  if (!company) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const totalPages = reviews ? Math.max(1, Math.ceil(reviews.meta.total / PAGE_SIZE)) : 1;
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/companies" className="text-sm font-medium text-primary hover:underline">บริษัทและรีวิว</Link>

      <header className="mt-4 flex flex-wrap items-center gap-4">
        <Avatar name={company.name} src={company.logo_url} size="lg" />
        <div className="min-w-0">
          <h1 className="text-3xl font-bold">{company.name}</h1>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">Verified by Platform</span>
            {company.university_partner && <span className="inline-block rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">University Partner</span>}
          </div>
          <div className="mt-2"><RatingSummary average={company.rating_avg} count={company.review_count} /></div>
        </div>
      </header>

      <div className="mt-4 flex flex-wrap gap-4 text-sm">
        <Link href={`/jobs?company_id=${company.id}`} className="font-semibold text-primary hover:underline">ดูประกาศงานของบริษัท</Link>
        {company.website && <a href={company.website} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">เว็บไซต์บริษัท</a>}
      </div>

      <section aria-labelledby="reviews-title" className="mt-10">
        <h2 id="reviews-title" className="text-xl font-bold">รีวิวจากผู้ฝึกงาน</h2>
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
                <li key={review.id} className="rounded-xl border border-border bg-surface p-5 shadow-sm">
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
            <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-lg border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
            <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
            <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-lg border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
          </nav>
        )}
      </section>
    </main>
  );
}
