'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  ApplicationEligibilityResponse, CreateApplicationRequest, Paginated, RecordConsentRequest, ResumeItem, SearchJobItem,
} from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

const COVER_LETTER_MAX = 5000; // api-contract §7.2

const BLOCKED: Record<string, string> = {
  EMAIL_NOT_VERIFIED: 'ต้องยืนยันอีเมลก่อนจึงจะสมัครงานได้',
  ADVISOR_NOT_LINKED: 'ต้องผูกอาจารย์ที่ปรึกษาให้เรียบร้อยก่อนสมัครงาน',
  REAPPLY_BLOCKED: 'คุณผ่านการฝึกงานแล้ว จึงสมัครงานใหม่ไม่ได้ เว้นแต่ผู้ดูแลระบบปลดล็อก',
};

/** แปลง error ของ POST /applications เป็นข้อความที่ผู้สมัครทำอะไรต่อได้ (รายละเอียดอยู่ใน `issues`) */
function applyFailure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'สมัครไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'STATE_CONFLICT') {
    if (cause.issues.includes('JOB_CLOSED')) return 'ประกาศนี้ปิดรับสมัครแล้ว';
    if (cause.issues.includes('DEADLINE_PASSED')) return 'เลยกำหนดปิดรับสมัครแล้ว';
    if (cause.issues.includes('JOB_NOT_PUBLISHED')) return 'ประกาศนี้ไม่เปิดรับสมัครในขณะนี้';
  }
  if (cause.code === 'ALREADY_APPLIED') return 'คุณสมัครประกาศนี้ไปแล้ว ดูสถานะได้ที่ "ใบสมัครของฉัน"';
  if (cause.code === 'NOT_FOUND' && cause.issues.length === 0) return 'ไม่พบประกาศหรือเรซูเม่ที่เลือก กรุณารีเฟรชหน้า';
  return BLOCKED[cause.code] ?? cause.message;
}

type Loaded = { eligibility: ApplicationEligibilityResponse; resumes: ResumeItem[] };

export function ApplyPanel({ job }: { job: SearchJobItem }) {
  const { request } = useAuth();
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [resumeId, setResumeId] = useState('');
  const [coverLetter, setCoverLetter] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // โหลดเมื่อเปิดแผงครั้งแรกเท่านั้น (ไม่ยิง API ให้ทุกคนที่แค่เปิดดูประกาศ)
  useEffect(() => {
    if (!open || loaded || loadFailed) return;
    let cancelled = false;
    Promise.all([
      request<ApplicationEligibilityResponse>('/me/application-eligibility'),
      request<Paginated<ResumeItem>>('/me/resumes'),
    ]).then(
      ([eligibility, resumes]) => {
        if (cancelled) return;
        setLoaded({ eligibility, resumes: resumes.data });
        setResumeId(resumes.data.find((resume) => resume.is_primary)?.id ?? resumes.data[0]?.id ?? '');
      },
      () => { if (!cancelled) setLoadFailed(true); },
    );
    return () => { cancelled = true; };
  }, [open, loaded, loadFailed, request]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!resumeId) { setError('กรุณาเลือกเรซูเม่'); return; }
    if (!consent) { setError('ต้องยินยอมให้ส่งเรซูเม่ให้บริษัทนี้ก่อนจึงจะสมัครได้'); return; }
    if (coverLetter.length > COVER_LETTER_MAX) { setError(`จดหมายสมัครต้องไม่เกิน ${COVER_LETTER_MAX} ตัวอักษร`); return; }
    setBusy(true);
    setError(null);
    try {
      // ต้องบันทึก Consent ที่ Identity ก่อน แล้วจึงสมัคร (api-contract §7.2) — บันทึกซ้ำได้ ไม่ทำให้เกิดข้อผิดพลาด
      const consentBody: RecordConsentRequest = { type: 'RESUME_SHARE', target_company_id: job.company.id };
      await request<void>('/users/me/consents', { method: 'POST', body: consentBody });
      const body: CreateApplicationRequest = {
        job_id: job.id, resume_id: resumeId, consent: true,
        ...(coverLetter.trim() ? { cover_letter: coverLetter.trim() } : {}),
      };
      await request('/applications', { method: 'POST', body });
      setDone(true);
    } catch (cause) { setError(applyFailure(cause)); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <div className="flex flex-col gap-2">
        <Notice tone="success">ส่งใบสมัครแล้ว บริษัทจะตอบกลับภายในเวลาที่กำหนด</Notice>
        <Link href="/student/applications" className="text-sm font-medium text-primary hover:underline">ดูใบสมัครของฉัน</Link>
      </div>
    );
  }

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="w-full rounded-lg bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover">
        สมัครงานนี้
      </button>
    );
  }

  if (loadFailed) return <Notice tone="error">โหลดข้อมูลการสมัครไม่สำเร็จ กรุณาลองใหม่ภายหลัง</Notice>;
  if (!loaded) return <p className="text-sm text-ink-soft">กำลังตรวจสอบสิทธิ์การสมัคร…</p>;

  if (!loaded.eligibility.can_apply) {
    const reason = loaded.eligibility.blocked_reason ?? '';
    return (
      <div className="flex flex-col gap-2">
        <Notice tone="error">{BLOCKED[reason] ?? 'ยังสมัครงานไม่ได้ในขณะนี้'}</Notice>
        {reason === 'ADVISOR_NOT_LINKED' && <Link href="/student/advisor" className="text-sm font-medium text-primary hover:underline">ไปผูกอาจารย์ที่ปรึกษา</Link>}
      </div>
    );
  }

  if (loaded.resumes.length === 0) {
    return (
      <div className="flex flex-col gap-2 text-sm">
        <p>ต้องมีเรซูเม่ก่อนจึงจะสมัครได้</p>
        <Link href="/student/profile" className="font-medium text-primary hover:underline">ไปอัปโหลดเรซูเม่</Link>
      </div>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-4 text-sm" noValidate>
      <fieldset>
        <legend className="font-medium">เลือกเรซูเม่</legend>
        <div className="mt-2 space-y-2">
          {loaded.resumes.map((resume, index) => (
            <label key={resume.id} className="flex items-center gap-2">
              <input type="radio" name="resume" value={resume.id} checked={resumeId === resume.id} onChange={() => setResumeId(resume.id)} className="accent-primary" />
              เรซูเม่ {index + 1}{resume.is_primary && ' (ไฟล์หลัก)'}
            </label>
          ))}
        </div>
      </fieldset>
      <label className="block font-medium">
        จดหมายสมัคร (ไม่บังคับ)
        <textarea value={coverLetter} onChange={(event) => setCoverLetter(event.target.value)} rows={4}
          className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft" />
        <span className="mt-1 block text-xs font-normal text-ink-soft">{coverLetter.length}/{COVER_LETTER_MAX}</span>
      </label>
      <label className="flex items-start gap-2">
        <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} className="mt-1 h-4 w-4 accent-primary" />
        <span>ฉันยินยอมให้ส่งเรซูเม่และโปรไฟล์ให้ {job.company.name} เพื่อพิจารณาใบสมัครนี้</span>
      </label>
      {error && <Notice tone="error">{error}</Notice>}
      <button type="submit" disabled={busy} className="w-full rounded-lg bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
        {busy ? 'กำลังส่งใบสมัคร…' : 'ส่งใบสมัคร'}
      </button>
    </form>
  );
}
