'use client';

import Link from 'next/link';
import { CircleCheck, CircleX, Clock5, Star } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ApplicationStatus, CreateReviewRequest, MyReviewItem, Paginated, ReviewStatus, StudentApplicationItem,
} from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Stars } from '@/components/ui/rating';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { formatDate } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';

/** สถานะที่เขียนรีวิวได้ — ตรงกับ Lifecycle `REVIEWABLE_STATUSES` (README §5.5) */
const REVIEWABLE: readonly ApplicationStatus[] = [
  'EVALUATED_PASS', 'EVALUATED_FAIL', 'FAIL_DISPUTED', 'REEVALUATION_REQUESTED', 'COMPLETED', 'TERMINATED', 'NO_EVALUATION',
];
/** Lifecycle `REVIEW_LIMITS` */
const TITLE_MAX = 200;
const BODY_MAX = 5000;

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

/** รีวิวเผยแพร่ทันทีหลังส่ง (ปรับ 2026-11-21 — ไม่มีขั้นรอตรวจ) `SUBMITTED` จึงแสดงเป็น "เผยแพร่แล้ว" เช่นกัน */
const REVIEW_STATUS: Record<ReviewStatus, { label: string; tone: StatusTone; icon: typeof Clock5 }> = {
  SUBMITTED: { label: 'เผยแพร่แล้ว', tone: 'success', icon: CircleCheck },
  PUBLISHED: { label: 'เผยแพร่แล้ว', tone: 'success', icon: CircleCheck },
  HELD: { label: 'ผู้ดูแลระบบกำลังตรวจ', tone: 'warning', icon: Clock5 },
  REMOVED: { label: 'ถูกถอดออก', tone: 'neutral', icon: CircleX },
};

type Message = { tone: 'error' | 'success'; text: string };

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ส่งรีวิวไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'ALREADY_REVIEWED') return 'คุณรีวิวการฝึกงานนี้ไปแล้ว';
  if (cause.issues.includes('REVIEW_NOT_OPEN')) return 'ยังเขียนรีวิวไม่ได้ รีวิวได้เมื่อบริษัทประเมินผลแล้วหรือการฝึกสิ้นสุด';
  return cause.message;
}

/**
 * หน้ารีวิวบริษัทของนักศึกษา (README §5.5, UAT-07/20/22/28)
 * - การฝึกงานที่เขียนรีวิวได้ = `GET /me/applications` ที่อยู่ในสถานะหลังประเมิน/สิ้นสุด และยังไม่มีรีวิว (`GET /me/reviews`)
 * - ส่ง `POST /applications/{id}/review` `{rating, title?, body, anonymous}` — 1 รีวิวต่อ 1 การฝึกงาน
 * - หลังส่งแสดงว่าเผยแพร่แล้ว และแจ้งว่า Admin อาจถอดออกถ้าถูกรายงาน (PM ตัดสิน 2026-11-22)
 */
export function ReviewPage() {
  const { request } = useAuth();
  const [apps, setApps] = useState<StudentApplicationItem[] | null>(null);
  const [reviews, setReviews] = useState<MyReviewItem[]>([]);
  const [loadError, setLoadError] = useState('');
  const [message, setMessage] = useState<Message | null>(null);
  const [writing, setWriting] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [myApps, myReviews] = await Promise.all([
        request<Paginated<StudentApplicationItem>>('/me/applications?page=1&page_size=100'),
        request<Paginated<MyReviewItem>>('/me/reviews?page=1&page_size=100'),
      ]);
      setApps(myApps.data);
      setReviews(myReviews.data);
      setLoadError('');
    } catch (cause) {
      setLoadError(cause instanceof ApiError ? cause.message : 'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่');
    }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  const reviewed = new Set(reviews.map((review) => review.application_id));
  const candidates = (apps ?? []).filter((app) => REVIEWABLE.includes(app.status) && !reviewed.has(app.id));
  const appById = new Map((apps ?? []).map((app) => [app.id, app]));

  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">รีวิวบริษัท</h1>
      <p className="mt-2 text-sm text-ink-soft">
        เล่าประสบการณ์ฝึกงานเพื่อช่วยรุ่นน้องเลือกบริษัท รีวิวได้ 1 ครั้งต่อการฝึกงาน 1 แห่ง หลังบริษัทประเมินผลหรือการฝึกสิ้นสุด
        และจะแสดงผลการฝึก (ผ่าน ไม่ผ่าน ยุติกลางคัน) คู่กับรีวิวเสมอ
      </p>

      {loadError && <div className="mt-4"><Notice tone="error">{loadError}</Notice></div>}
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {!apps && !loadError && <p className="mt-6 text-sm text-ink-soft">กำลังโหลด…</p>}

      {apps && (
        <section aria-labelledby="write-title" className="mt-8">
          <h2 id="write-title" className="text-xl font-semibold">รอเขียนรีวิว</h2>
          {candidates.length === 0 ? (
            <p className="mt-3 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">ยังไม่มีการฝึกงานที่รอรีวิว</p>
          ) : (
            <ul className="mt-3 space-y-4">
              {candidates.map((app) => (
                <li key={app.id} className="rounded-xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold">{app.company_name}</p>
                      <p className="text-sm text-ink-soft">{app.job_title}</p>
                    </div>
                    {writing !== app.id && (
                      <button type="button" onClick={() => { setWriting(app.id); setMessage(null); }}
                        className="rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover active:scale-[0.97]">เขียนรีวิว</button>
                    )}
                  </div>
                  {writing === app.id && (
                    <ReviewForm
                      app={app}
                      onCancel={() => setWriting(null)}
                      onDone={async () => {
                        setWriting(null);
                        setMessage({
                          tone: 'success',
                          text: `เผยแพร่รีวิว ${app.company_name} แล้ว ถ้ามีผู้รายงานว่ารีวิวไม่เหมาะสม ผู้ดูแลระบบอาจพิจารณาถอดรีวิวออก`,
                        });
                        await load();
                      }}
                    />
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {reviews.length > 0 && (
        <section aria-labelledby="mine-title" className="mt-10">
          <h2 id="mine-title" className="text-xl font-semibold">รีวิวของฉัน</h2>
          <ul className="mt-3 space-y-4">
            {reviews.map((review) => {
              const view = REVIEW_STATUS[review.status];
              const app = appById.get(review.application_id);
              return (
                <li key={review.id} className="rounded-xl border border-border bg-surface p-5">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="font-semibold">{app?.company_name ?? 'บริษัท'}</p>
                      <p className="mt-1 flex items-center gap-2 text-xs text-ink-soft">
                        <Stars value={review.rating} /> {formatDate(review.created_at)} · {review.anonymous ? 'ไม่ระบุชื่อ' : 'แสดงชื่อ'}
                      </p>
                    </div>
                    <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>
                  </div>
                  {review.title && <p className="mt-3 font-medium">{review.title}</p>}
                  <p className="mt-1 whitespace-pre-line text-sm">{review.body}</p>
                  {review.status === 'REMOVED' && <p className="mt-2 text-xs text-ink-soft">ผู้ดูแลระบบถอดรีวิวนี้ออกหลังมีผู้รายงาน รีวิวนี้จึงไม่แสดงในหน้าบริษัทแล้ว</p>}
                  {review.status !== 'REMOVED' && (
                    <Link href={`/companies/item?id=${encodeURIComponent(review.company_id)}`} className="mt-2 inline-block text-sm font-medium text-primary hover:underline">
                      ดูในหน้าบริษัท
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}

function ReviewForm({ app, onCancel, onDone }: { app: StudentApplicationItem; onCancel: () => void; onDone: () => Promise<void> }) {
  const { request } = useAuth();
  const [rating, setRating] = useState(0);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [anonymous, setAnonymous] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (rating < 1) { setError('กรุณาให้คะแนน 1–5 ดาว'); return; }
    if (!body.trim()) { setError('กรุณาเขียนเนื้อหารีวิว'); return; }
    if (title.trim().length > TITLE_MAX || body.trim().length > BODY_MAX) { setError(`หัวข้อไม่เกิน ${TITLE_MAX} และเนื้อหาไม่เกิน ${BODY_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setError('');
    try {
      const payload: CreateReviewRequest = {
        rating: rating as CreateReviewRequest['rating'], body: body.trim(), anonymous, ...(title.trim() ? { title: title.trim() } : {}),
      };
      await request(`/applications/${encodeURIComponent(app.id)}/review`, { method: 'POST', body: payload });
      await onDone();
    } catch (cause) {
      setError(failure(cause));
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={(event) => void submit(event)} noValidate className="mt-4 space-y-4 rounded-xl bg-surface-muted p-4 text-sm">
      <fieldset>
        <legend className="font-medium">คะแนน</legend>
        <div className="mt-1 flex gap-1" role="radiogroup" aria-label="คะแนน 1 ถึง 5 ดาว">
          {[1, 2, 3, 4, 5].map((value) => (
            <button key={value} type="button" role="radio" aria-checked={rating === value} aria-label={`${value} ดาว`} onClick={() => setRating(value)}
              className="rounded-lg p-1 hover:bg-surface">
              <Star aria-hidden="true" className={`h-7 w-7 ${value <= rating ? 'fill-warning text-warning' : 'text-ink-muted'}`} strokeWidth={2} />
            </button>
          ))}
        </div>
      </fieldset>
      <label className="block font-medium">
        หัวข้อ (ไม่บังคับ)
        <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={TITLE_MAX} className={inputClass} />
      </label>
      <label className="block font-medium">
        เนื้อหา
        <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={5} className={inputClass} />
        <span className="mt-1 block text-xs font-normal text-ink-soft">{body.length}/{BODY_MAX} · ไม่ควรใส่ข้อมูลส่วนตัวของผู้อื่น เช่น เบอร์โทรหรือไลน์</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={anonymous} onChange={(event) => setAnonymous(event.target.checked)} className="mt-1" />
        <span>
          <span className="font-medium">ไม่ระบุชื่อ</span>
          <span className="block text-xs text-ink-soft">แสดงเฉพาะสาขาและชั้นปีของคุณแทนชื่อ</span>
        </span>
      </label>
      <p className="text-xs text-ink-soft">
        รีวิวจะเผยแพร่ในหน้าบริษัททันทีหลังส่ง และแก้ไขภายหลังไม่ได้ ถ้ามีผู้รายงานว่ารีวิวไม่เหมาะสม ผู้ดูแลระบบอาจพิจารณาถอดรีวิวออก
      </p>
      {error && <Notice tone="error">{error}</Notice>}
      <div className="flex gap-3">
        <button type="submit" disabled={busy} className="rounded-full bg-primary px-5 py-2 font-semibold text-white hover:bg-primary-hover active:scale-[0.97] disabled:opacity-60">
          {busy ? 'กำลังส่ง…' : 'ส่งรีวิว'}
        </button>
        <button type="button" onClick={onCancel} className="rounded-full border border-border px-5 py-2 font-semibold hover:bg-surface">ยกเลิก</button>
      </div>
    </form>
  );
}
