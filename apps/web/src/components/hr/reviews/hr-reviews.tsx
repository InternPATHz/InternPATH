'use client';

import Link from 'next/link';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { Paginated, PublicReviewItem, ReplyReviewRequest, ReplyReviewResponse, UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { OUTCOME, reviewDateFormat, reviewerLabel } from '@/components/companies/review-display';
import { Stars } from '@/components/ui/rating';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 10;
/** Lifecycle `REVIEW_LIMITS.REPLY_MAX` */
const REPLY_MAX = 2000;

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

/**
 * HR ตอบรีวิวของบริษัท (api-contract §7.6)
 * - รายการ: `GET /companies/{company_id}/reviews` (เฉพาะ `PUBLISHED` ใหม่สุดก่อน — ชุดเดียวกับที่สาธารณะเห็น) โดย company_id จาก `GET /users/me`
 * - ตอบ: `POST /hr/reviews/{id}/reply` `{body}` ได้ 1 ครั้งต่อรีวิว (`409 ALREADY_REPLIED`) — สมาชิก HR ทุกคนของบริษัทตอบได้
 */
export function HrReviews() {
  const { request } = useAuth();
  const [companyId, setCompanyId] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [reviews, setReviews] = useState<Paginated<PublicReviewItem> | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [revision, setRevision] = useState(0);
  const [notice, setNotice] = useState('');
  const sequence = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    request<UserMeResponse>('/users/me').then(
      (me) => { if (!cancelled) { if (me.company?.id) setCompanyId(me.company.id); else setError('บัญชีนี้ยังไม่ได้อยู่ในบริษัท'); } },
      (cause) => { if (!cancelled) setError(cause instanceof ApiError ? cause.message : 'โหลดข้อมูลบริษัทไม่สำเร็จ กรุณาลองใหม่'); },
    );
    return () => { cancelled = true; };
  }, [request, revision]);

  const load = useCallback(async () => {
    if (!companyId) return;
    const version = ++sequence.current;
    try {
      const next = await request<Paginated<PublicReviewItem>>(`/companies/${encodeURIComponent(companyId)}/reviews?page=${page}&page_size=${PAGE_SIZE}`);
      if (version !== sequence.current) return;
      setReviews(next);
      setError(null);
    } catch (cause) {
      if (version !== sequence.current) return;
      setError(cause instanceof ApiError ? cause.message : 'โหลดรีวิวไม่สำเร็จ กรุณาลองใหม่');
    }
  }, [companyId, page, request]);

  useEffect(() => { setReviews(null); }, [companyId, page]);
  useEffect(() => { void load(); return () => { sequence.current++; }; }, [load, revision]);

  function recordReply(reply: ReplyReviewResponse) {
    setReviews((current) => current && {
      ...current,
      data: current.data.map((item) => item.id === reply.review_id ? { ...item, reply } : item),
    });
  }

  const totalPages = reviews ? Math.max(1, Math.ceil(reviews.meta.total / PAGE_SIZE)) : 1;
  const waiting = reviews?.data.filter((review) => !review.reply).length ?? 0;

  const selected = reviews?.data.find((item) => item.id === selectedId) ?? reviews?.data[0];
  return (
    <main className="mx-auto max-w-6xl [overflow-wrap:anywhere] px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">รีวิวบริษัท</h1>
      <p className="mt-2 text-sm text-ink-soft">
        รีวิวจากผู้ฝึกงานที่เผยแพร่แล้ว ตอบได้รีวิวละ 1 ครั้ง คำตอบแสดงต่อสาธารณะในหน้าบริษัทและแก้ไขภายหลังไม่ได้
        {companyId && <> · <Link href={`/companies/item?id=${companyId}`} className="font-medium text-primary hover:underline">ดูหน้าบริษัทแบบสาธารณะ</Link></>}
      </p>

      {notice && <p role="status">{notice}</p>}
      {error && <div className="mt-6"><Notice tone="error">{error} <button onClick={() => setRevision((r) => r + 1)} className="underline">ลองอีกครั้ง</button></Notice></div>}
      {!reviews && !error && <p className="mt-6 text-sm text-ink-soft">กำลังโหลด…</p>}
      {reviews && <p role="status" className="mt-6 text-sm text-ink-soft">ทั้งหมด {reviews.meta.total} รีวิว · หน้านี้รอตอบ {waiting} รีวิว</p>}
      {reviews && reviews.data.length === 0 && (
        <div className="mt-4 rounded-xl border border-dashed border-border p-8 text-center text-sm text-ink-soft">ยังไม่มีรีวิวที่เผยแพร่</div>
      )}
      {reviews && reviews.data.length > 0 && (
        <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
          <ul aria-label="เลือกรีวิว" className="hidden min-w-0 self-start divide-y divide-border rounded-xl border border-border lg:block">
            {reviews.data.map((review) => <li key={review.id}><button onClick={() => { setSelectedId(review.id); setNotice(''); }} aria-pressed={selected?.id === review.id} className="w-full min-w-0 p-3 text-left aria-pressed:bg-primary-soft">
              <span className="block truncate font-semibold">{review.title || reviewerLabel(review)}</span><span className="text-sm">{review.rating}/5 · {review.reply ? 'ตอบแล้ว' : 'รอตอบ'} · {reviewDateFormat.format(new Date(review.published_at))}</span>
            </button></li>)}
          </ul>
          <ul className="min-w-0 space-y-4">{reviews.data.map((review) => <ReviewCard key={review.id} review={review} selected={selected?.id === review.id} onReplied={recordReply} onConflict={() => setRevision((value) => value + 1)} notify={setNotice} />)}</ul>
        </div>
      )}
      {reviews && reviews.meta.total > PAGE_SIZE && (
        <nav aria-label="เลือกหน้ารีวิว" className="mt-6 flex items-center justify-center gap-4 text-sm">
          <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ก่อนหน้า</button>
          <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
          <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)} className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40">ถัดไป</button>
        </nav>
      )}
    </main>
  );
}

type ReplyActions = {
  notify: (message: string) => void;
  onReplied: (reply: ReplyReviewResponse) => void;
  onConflict: () => void;
};

function ReviewCard({ review, selected, onReplied, onConflict, notify }: ReplyActions & { review: PublicReviewItem; selected: boolean }) {
  const outcome = OUTCOME[review.outcome_label];
  return (
    <li className={`rounded-xl border border-border bg-surface p-5 ${selected ? '' : 'lg:hidden'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Stars value={review.rating} />
        <StatusBadge tone={outcome.tone} icon={outcome.icon}>{outcome.label}</StatusBadge>
      </div>
      <p className="mt-2 text-xs text-ink-soft">{reviewerLabel(review)} · {reviewDateFormat.format(new Date(review.published_at))}</p>
      {review.title && <h2 className="mt-3 font-semibold">{review.title}</h2>}
      <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">{review.body}</p>
      {review.reply ? (
        <div className="mt-4 rounded-lg bg-surface-muted p-3 text-sm">
          <p className="text-xs font-medium text-ink-soft">คำตอบจากบริษัท · {reviewDateFormat.format(new Date(review.reply.created_at))}</p>
          <p className="mt-1 whitespace-pre-line">{review.reply.body}</p>
        </div>
      ) : (
        <ReplyForm reviewId={review.id} notify={notify} onReplied={onReplied} onConflict={onConflict} />
      )}
    </li>
  );
}

function ReplyForm({ reviewId, onReplied, onConflict, notify }: ReplyActions & { reviewId: string }) {
  const { request } = useAuth();
  const fieldId = useId();
  const [preview, setPreview] = useState(false);
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = body.trim();
    if (!value) { setMessage('กรุณาพิมพ์คำตอบก่อนส่ง'); return; }
    if (!preview) { setPreview(true); setMessage(null); return; }
    setBusy(true);
    setMessage(null);
    try {
      const payload: ReplyReviewRequest = { body: value };
      const reply = await request<ReplyReviewResponse>(`/hr/reviews/${encodeURIComponent(reviewId)}/reply`, { method: 'POST', body: payload });
      onReplied(reply);
      notify('เผยแพร่คำตอบแล้ว');
    } catch (cause) {
      if (cause instanceof ApiError && (cause.code === 'ALREADY_REPLIED' || cause.status === 404)) {
        notify(cause.status === 404 ? 'รีวิวนี้ไม่พร้อมให้ตอบแล้ว' : 'สมาชิกทีมตอบรีวิวนี้แล้ว');
        // มีสมาชิกคนอื่นตอบไปแล้ว — โหลดใหม่เพื่อแสดงคำตอบนั้นแทนฟอร์ม
        onConflict();
        return;
      }
      setMessage(cause instanceof ApiError ? cause.message : 'ส่งคำตอบไม่สำเร็จ กรุณาลองใหม่');
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="mt-4 space-y-2 border-t border-border pt-4 text-sm">
      <label htmlFor={`${fieldId}-reply`} className="block font-medium">ตอบรีวิวนี้ในนามบริษัท</label>
      <textarea readOnly={preview} id={`${fieldId}-reply`} value={body} onChange={(event) => setBody(event.target.value)} rows={3} maxLength={REPLY_MAX}
        aria-describedby={`${fieldId}-reply-hint`} aria-invalid={message ? true : undefined} className={inputClass} />
      <p id={`${fieldId}-reply-hint`} className="text-xs text-ink-soft">{body.length}/{REPLY_MAX} · ตอบได้ครั้งเดียวและแก้ไขภายหลังไม่ได้</p>
      {preview && <p className="text-sm">ตรวจคำตอบก่อนเผยแพร่ <button type="button" className="text-primary" onClick={() => setPreview(false)}>กลับไปแก้ไข</button></p>}
      {message && <Notice tone="error">{message}</Notice>}
      <button type="submit" disabled={busy} className="rounded-full bg-primary px-5 py-2 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
        {busy ? 'กำลังส่ง…' : preview ? 'ยืนยันเผยแพร่คำตอบ' : 'ดูตัวอย่างคำตอบ'}
      </button>
    </form>
  );
}
