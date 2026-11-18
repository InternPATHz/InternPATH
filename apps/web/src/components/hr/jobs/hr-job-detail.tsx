'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { HrJobDetail, VerificationResultResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import {
  EDITABLE_STATUSES, JobStatusBadge, SUBMITTABLE_STATUSES, WORK_MODE_LABEL, formatDay, jobTitleOf,
} from '@/components/hr/jobs/job-ui';
import { ApiError } from '@/lib/api';
import { HR_JOBS_MOCK, hrJobsApi, missingRequired } from '@/lib/hr-jobs';
import { CATEGORIES } from '@/lib/mock-landing';

const APPEAL_MIN = 20;   // api-contract §6.5
const APPEAL_MAX = 2000;
// สถานะที่มีผลตรวจให้ HR ดู (ถูกตีกลับ / รอ Admin) — เรียก Verification เฉพาะสถานะเหล่านี้
const RESULT_STATUSES = ['AUTO_REJECTED', 'ADMIN_REJECTED', 'PENDING_REVIEW'];

const RISK_LABEL = { LOW: 'ความเสี่ยงต่ำ', MEDIUM: 'ความเสี่ยงปานกลาง', HIGH: 'ความเสี่ยงสูง' } as const;

const failure = (cause: unknown) => (cause instanceof ApiError || cause instanceof Error ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>;
}

function TextSection({ title, text }: { title: string; text: string | null }) {
  if (!text) return null;
  return (
    <section className="mt-6">
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-2 whitespace-pre-line text-ink-soft">{text}</p>
    </section>
  );
}

export function HrJobDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const api = useMemo(() => hrJobsApi(request), [request]);
  const [job, setJob] = useState<HrJobDetail | null>(null);
  const [result, setResult] = useState<VerificationResultResponse | null>(null);
  const [loadError, setLoadError] = useState<{ missing: boolean; text: string } | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [statement, setStatement] = useState('');
  const [appealing, setAppealing] = useState(false);

  const load = useCallback(async () => {
    try {
      const fresh = await api.get(id);
      setJob(fresh);
      setResult(RESULT_STATUSES.includes(fresh.status) ? await api.verificationResult(id) : null);
      setLoadError(null);
    } catch (cause) {
      const missing = cause instanceof Error && (cause as { status?: number }).status === 404;
      setLoadError({ missing, text: missing ? 'ไม่พบประกาศนี้ในบริษัทของคุณ' : failure(cause) });
    }
  }, [api, id]);

  useEffect(() => {
    if (!id) { setLoadError({ missing: true, text: 'ไม่พบประกาศนี้ในบริษัทของคุณ' }); return; }
    void load();
  }, [id, load]);

  // สถานะที่ระบบเปลี่ยนเอง (กำลังตรวจ / รอ Admin) ⇒ โหลดซ้ำเป็นระยะจนกว่าจะได้ผล
  const waiting = job?.status === 'VERIFYING' || job?.status === 'PENDING_REVIEW';
  useEffect(() => {
    if (!waiting) return undefined;
    const timer = setInterval(() => { void load(); }, 3000);
    return () => clearInterval(timer);
  }, [waiting, load]);

  async function act(run: () => Promise<unknown>, success: string) {
    setBusy(true);
    setMessage(null);
    try { await run(); await load(); setMessage({ tone: 'success', text: success }); }
    catch (cause) { setMessage({ tone: 'error', text: failure(cause) }); await load(); }
    finally { setBusy(false); }
  }

  async function submitAppeal(event: FormEvent) {
    event.preventDefault();
    const value = statement.trim();
    if (value.length < APPEAL_MIN) { setMessage({ tone: 'error', text: `คำอธิบายอุทธรณ์ต้องไม่น้อยกว่า ${APPEAL_MIN} ตัวอักษร` }); return; }
    if (value.length > APPEAL_MAX) { setMessage({ tone: 'error', text: `คำอธิบายอุทธรณ์ต้องไม่เกิน ${APPEAL_MAX} ตัวอักษร` }); return; }
    await act(() => api.appeal(id, value), 'ส่งอุทธรณ์แล้ว รอผู้ดูแลระบบตรวจสอบ');
    setAppealing(false);
    setStatement('');
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-bold">{loadError.missing ? 'ไม่พบประกาศนี้' : 'โหลดประกาศไม่สำเร็จ'}</h1>
        <p className="mt-2 text-sm text-ink-soft">{loadError.text}</p>
        <Link href="/hr/jobs" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปประกาศของฉัน</Link>
      </main>
    );
  }
  if (!job) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const { status } = job;
  const category = CATEGORIES.find((entry) => entry.id === job.category)?.label;
  const canSubmit = SUBMITTABLE_STATUSES.includes(status);
  const missing = canSubmit ? missingRequired(job as unknown as Record<string, unknown>) : [];
  const showApplicants = status === 'PUBLISHED' || status === 'CLOSED';
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/hr/jobs" className="text-sm font-medium text-primary hover:underline">ประกาศของฉัน</Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">{jobTitleOf(job)}</h1>
          <p className="mt-1 text-sm text-ink-soft">{[category, job.work_mode ? WORK_MODE_LABEL[job.work_mode] : null, job.location].filter(Boolean).join(' · ')}</p>
          {HR_JOBS_MOCK && <p className="mt-1 text-xs text-warning-text">ข้อมูลในหน้านี้เป็นข้อมูลจำลอง</p>}
        </div>
        <JobStatusBadge status={status} />
      </header>

      {waiting && (
        <div className="mt-4"><Notice tone="success">{status === 'VERIFYING' ? 'กำลังตรวจสอบประกาศ หน้านี้จะอัปเดตเองเมื่อมีผล' : 'ผู้ดูแลระบบกำลังตรวจสอบ หน้านี้จะอัปเดตเองเมื่อมีผล'}</Notice></div>
      )}
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <div className="mt-4 flex flex-wrap gap-3">
        {EDITABLE_STATUSES.includes(status) && (
          <Link href={`/hr/jobs/form?id=${job.id}`} className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted">แก้ไข</Link>
        )}
        {canSubmit && (
          <button type="button" disabled={busy || missing.length > 0} onClick={() => void act(() => api.submit(job.id), 'ส่งตรวจแล้ว')}
            className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50">
            ส่งตรวจ
          </button>
        )}
        {status === 'PUBLISHED' && (
          <button type="button" disabled={busy} onClick={() => { if (window.confirm('ปิดประกาศนี้? ผู้สมัครใหม่จะสมัครไม่ได้ ส่วนใบสมัครที่มีอยู่ดำเนินต่อ')) void act(() => api.close(job.id), 'ปิดประกาศแล้ว'); }}
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">ปิดประกาศ</button>
        )}
        {status === 'CLOSED' && (
          <button type="button" disabled={busy} onClick={() => void act(() => api.reopen(job.id), 'เปิดประกาศอีกครั้งแล้ว')}
            className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">เปิดประกาศอีกครั้ง</button>
        )}
        {showApplicants && (
          <Link href={`/hr/applicants?job_id=${job.id}`} className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted">ดูผู้สมัคร</Link>
        )}
      </div>
      {canSubmit && missing.length > 0 && <p className="mt-2 text-xs text-ink-soft">ยังกรอกไม่ครบ จึงส่งตรวจไม่ได้ กด "แก้ไข" เพื่อกรอกข้อมูลบังคับให้ครบ</p>}

      {result && (
        <section aria-labelledby="result-title" className="mt-6 rounded-xl border border-border bg-surface-muted p-4">
          <h2 id="result-title" className="text-lg font-bold">ผลการตรวจสอบ</h2>
          <p className="mt-1 text-sm text-ink-soft">{RISK_LABEL[result.risk_level]} (คะแนน {result.risk_score}){result.is_appeal && ' · ผลจากการอุทธรณ์'}</p>
          {result.admin_reason && <p className="mt-3 text-sm"><span className="font-medium">เหตุผลจากผู้ดูแลระบบ:</span> {result.admin_reason}</p>}
          {result.reasons.length > 0 && (
            <ul className="mt-3 space-y-2 text-sm">
              {result.reasons.map((reason, index) => (
                <li key={`${reason.code}-${index}`}>{reason.detail}{reason.matched_text && <span className="text-ink-soft"> (พบ "{reason.matched_text}")</span>}</li>
              ))}
            </ul>
          )}
          {result.can_appeal && !appealing && (
            <button type="button" onClick={() => { setAppealing(true); setMessage(null); }} className="mt-4 rounded-lg border border-border px-5 py-2 text-sm font-semibold hover:bg-surface">อุทธรณ์ผลการตรวจ</button>
          )}
          {!result.can_appeal && status === 'AUTO_REJECTED' && <p className="mt-3 text-xs text-ink-soft">อุทธรณ์ได้ 1 ครั้งต่อประกาศ หากต้องการส่งใหม่ให้แก้ไขเนื้อหาแล้วส่งตรวจ</p>}
          {appealing && (
            <form onSubmit={(event) => void submitAppeal(event)} noValidate className="mt-4 space-y-3 text-sm">
              <label className="block font-medium">
                อธิบายเหตุผลที่ขออุทธรณ์
                <textarea value={statement} onChange={(event) => setStatement(event.target.value)} rows={4}
                  className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
                <span className="mt-1 block text-xs font-normal text-ink-soft">{statement.length}/{APPEAL_MAX} (อย่างน้อย {APPEAL_MIN} ตัวอักษร)</span>
              </label>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className="rounded-lg bg-primary px-5 py-2 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">{busy ? 'กำลังส่ง…' : 'ส่งอุทธรณ์'}</button>
                <button type="button" onClick={() => setAppealing(false)} className="rounded-lg border border-border px-5 py-2 font-semibold hover:bg-surface">ยกเลิก</button>
              </div>
            </form>
          )}
        </section>
      )}

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-border bg-surface-muted p-4 sm:grid-cols-3">
        <Fact label="เบี้ยเลี้ยง">{job.allowance ? (job.allowance.text || (job.allowance.type === 'AMOUNT' ? `${job.allowance.amount_thb ?? '-'} บาท` : 'ไม่มีเบี้ยเลี้ยง')) : '-'}</Fact>
        <Fact label="ชั่วโมงต่อสัปดาห์">{job.hours_per_week ?? '-'}</Fact>
        <Fact label="จำนวนที่รับ">{job.quota !== null ? `${job.quota} ตำแหน่ง${job.quota_available !== null ? ` (เหลือ ${job.quota_available})` : ''}` : '-'}</Fact>
        <Fact label="ช่วงฝึกงาน">{job.period.start && job.period.end ? `${formatDay(job.period.start)} – ${formatDay(job.period.end)}` : '-'}</Fact>
        <Fact label="ปิดรับสมัคร">{job.application_deadline ? formatDay(job.application_deadline) : '-'}</Fact>
        <Fact label="สาขาที่เปิดรับ">{job.target_majors && job.target_majors.length > 0 ? job.target_majors.join(', ') : '-'}</Fact>
      </dl>

      <TextSection title="รายละเอียดงาน" text={job.description} />
      <TextSection title="หน้าที่ความรับผิดชอบ" text={job.responsibilities} />
      <TextSection title="คุณสมบัติผู้สมัคร" text={job.qualifications} />
    </main>
  );
}
