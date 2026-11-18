'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { CreateProblemReportRequest, ProblemReportCategory, StudentApplicationDetail } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ACTOR_LABEL, ApplicationStatusBadge, formatDate, formatDateTime } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';
import { APPLICATION_STATUS, statusView } from '@/lib/status-map';

const REASON_MAX = 2000;     // request-termination (api-contract §7.2)
const LONG_TEXT_MAX = 5000;  // dispute-fail statement / รายงานปัญหา

const PROBLEM_CATEGORIES: Array<[ProblemReportCategory, string]> = [
  ['WORKLOAD_OR_HOURS', 'ปริมาณงานหรือชั่วโมงทำงาน'],
  ['NO_ALLOWANCE_AS_PROMISED', 'ไม่ได้รับค่าตอบแทนตามที่ระบุ'],
  ['UNSAFE_OR_HARASSMENT', 'ความไม่ปลอดภัยหรือการคุกคาม'],
  ['DIFFERENT_FROM_JOB_POST', 'งานไม่ตรงกับประกาศ'],
  ['OTHER', 'อื่น ๆ'],
];

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

type Message = { tone: 'error' | 'success'; text: string };

function failure(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>;
}

export function ApplicationDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const [app, setApp] = useState<StudentApplicationDetail | null>(null);
  const [loadError, setLoadError] = useState<{ missing: boolean; text: string } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<'terminate' | 'dispute' | 'problem' | null>(null);
  const [text, setText] = useState('');
  const [category, setCategory] = useState<ProblemReportCategory>('WORKLOAD_OR_HOURS');

  const load = useCallback(async () => {
    try {
      setApp(await request<StudentApplicationDetail>(`/me/applications/${encodeURIComponent(id)}`));
      setLoadError(null);
    } catch (cause) {
      const missing = cause instanceof ApiError && cause.status === 404;
      setLoadError({ missing, text: missing ? 'ไม่พบใบสมัครนี้' : failure(cause) });
    }
  }, [request, id]);

  useEffect(() => {
    if (!id) { setLoadError({ missing: true, text: 'ไม่พบใบสมัครนี้' }); return; }
    setApp(null);
    void load();
  }, [id, load]);

  /** เรียก action ของใบสมัครนี้ แล้วโหลดสถานะใหม่ (สถานะจริงมาจากเซิร์ฟเวอร์เสมอ) */
  async function act(path: string, body: unknown, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      await request(`/applications/${encodeURIComponent(id)}${path}`, { method: 'POST', body });
      setForm(null);
      setText('');
      await load();
      setMessage({ tone: 'success', text: success });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
      await load(); // สถานะอาจเปลี่ยนไปแล้วระหว่างนั้น (409) ให้ปุ่มตรงกับความจริง
    } finally { setBusy(false); }
  }

  function confirmAndAct(question: string, action: string, success: string) {
    if (window.confirm(question)) void act(`/actions/${action}`, undefined, success);
  }

  function submitForm(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (form === 'terminate') {
      if (!value) { setMessage({ tone: 'error', text: 'กรุณาระบุเหตุผลที่ขอยุติการฝึก' }); return; }
      if (value.length > REASON_MAX) { setMessage({ tone: 'error', text: `เหตุผลต้องไม่เกิน ${REASON_MAX} ตัวอักษร` }); return; }
      void act('/actions/request-termination', { reason: value }, 'ส่งคำขอยุติการฝึกแล้ว');
    } else if (form === 'dispute') {
      if (!value) { setMessage({ tone: 'error', text: 'กรุณาระบุเหตุผลที่โต้แย้งผลประเมิน' }); return; }
      if (value.length > LONG_TEXT_MAX) { setMessage({ tone: 'error', text: `ข้อความต้องไม่เกิน ${LONG_TEXT_MAX} ตัวอักษร` }); return; }
      void act('/actions/dispute-fail', { statement: value }, 'ส่งคำโต้แย้งแล้ว อาจารย์ที่ปรึกษาจะพิจารณา');
    } else if (form === 'problem') {
      if (!value) { setMessage({ tone: 'error', text: 'กรุณาอธิบายปัญหาที่พบ' }); return; }
      if (value.length > LONG_TEXT_MAX) { setMessage({ tone: 'error', text: `ข้อความต้องไม่เกิน ${LONG_TEXT_MAX} ตัวอักษร` }); return; }
      const body: CreateProblemReportRequest = { category, detail: value };
      void act('/problem-reports', body, 'ส่งรายงานปัญหาถึงอาจารย์และผู้ดูแลระบบแล้ว (บริษัทมองไม่เห็น)');
    }
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-bold">{loadError.missing ? 'ไม่พบใบสมัครนี้' : 'โหลดใบสมัครไม่สำเร็จ'}</h1>
        {!loadError.missing && <p className="mt-2 text-sm text-ink-soft">{loadError.text}</p>}
        <Link href="/student/applications" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปใบสมัครของฉัน</Link>
      </main>
    );
  }
  if (!app) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const can = (action: string) => app.available_actions.includes(action);
  const formTitle = { terminate: 'ขอยุติการฝึกงาน', dispute: 'โต้แย้งผลประเมิน', problem: 'รายงานปัญหาระหว่างฝึกงาน' }[form ?? 'terminate'];
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/student/applications" className="text-sm font-medium text-primary hover:underline">← ใบสมัครของฉัน</Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold">{app.job_title}</h1>
          <p className="mt-1 text-ink-soft">{app.company_name}</p>
        </div>
        <ApplicationStatusBadge status={app.status} academicResult={app.academic_result} />
      </header>

      {app.frozen && <div className="mt-4"><Notice tone="error">ประกาศนี้ถูกระงับชั่วคราว ใบสมัครของคุณจึงยังไม่เดินต่อจนกว่าผู้ดูแลระบบจะตรวจสอบเสร็จ</Notice></div>}
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl border border-border bg-surface-muted p-4 sm:grid-cols-3">
        <Fact label="สมัครเมื่อ">{formatDate(app.created_at)}</Fact>
        <Fact label="เริ่มฝึก (ตามข้อเสนอ)">{app.start_date ? formatDate(app.start_date) : '-'}</Fact>
        <Fact label="สิ้นสุด (ตามข้อเสนอ)">{app.end_date ? formatDate(app.end_date) : '-'}</Fact>
        {app.actual_start_date && <Fact label="เริ่มฝึกจริง">{formatDate(app.actual_start_date)}</Fact>}
        {app.actual_end_date && <Fact label="สิ้นสุดจริง">{formatDate(app.actual_end_date)}</Fact>}
        {app.major_mismatch && <Fact label="สาขา">ไม่ตรงกับที่ประกาศระบุ</Fact>}
      </dl>

      {(app.status === 'EVALUATED_PASS' || app.status === 'COMPLETED') && (
        <p className="mt-4 text-sm">
          ถ้าบริษัทออก E-Certificate ให้แล้ว ดูและดาวน์โหลดได้ที่ <Link href="/student/certificates" className="font-medium text-primary hover:underline">ใบรับรองของฉัน</Link>
        </p>
      )}
      {app.terminate_reason && (
        <p className="mt-4 text-sm text-ink-soft">
          ยุติโดย {app.terminated_by ? ACTOR_LABEL[{ COMPANY: 'COMPANY_HR', STUDENT: 'STUDENT', ADVISOR: 'ADVISOR', ADMIN: 'PLATFORM_ADMIN' }[app.terminated_by]] : '-'}: {app.terminate_reason}
        </p>
      )}
      {app.cover_letter && (
        <section className="mt-6">
          <h2 className="text-lg font-bold">จดหมายสมัคร</h2>
          <p className="mt-2 whitespace-pre-line text-ink-soft">{app.cover_letter}</p>
        </section>
      )}

      {(app.available_actions.length > 0 || app.status === 'IN_PROGRESS') && (
        <section aria-labelledby="actions-title" className="mt-8">
          <h2 id="actions-title" className="text-lg font-bold">ดำเนินการ</h2>
          {app.status === 'HR_ACCEPTED' && (
            <p className="mt-1 text-sm text-ink-soft">การยืนยันข้อเสนอนี้จะปฏิเสธข้อเสนออื่นที่คุณได้รับอัตโนมัติ (ยืนยันได้ทีละที่)</p>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            {can('confirm-offer') && (
              <button type="button" disabled={busy} onClick={() => confirmAndAct('ยืนยันรับข้อเสนอนี้? ข้อเสนออื่นของคุณจะถูกปฏิเสธอัตโนมัติ', 'confirm-offer', 'ยืนยันข้อเสนอแล้ว รออาจารย์ที่ปรึกษาอนุมัติ')}
                className="rounded-lg bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ยืนยันรับข้อเสนอ</button>
            )}
            {can('decline-offer') && (
              <button type="button" disabled={busy} onClick={() => confirmAndAct('ปฏิเสธข้อเสนอนี้?', 'decline-offer', 'ปฏิเสธข้อเสนอแล้ว')}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">ปฏิเสธข้อเสนอ</button>
            )}
            {can('withdraw') && (
              <button type="button" disabled={busy} onClick={() => confirmAndAct('ถอนใบสมัครนี้? ทำย้อนกลับไม่ได้', 'withdraw', 'ถอนใบสมัครแล้ว')}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">ถอนใบสมัคร</button>
            )}
            {can('request-termination') && (
              <button type="button" disabled={busy} onClick={() => { setForm('terminate'); setText(''); setMessage(null); }}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">ขอยุติการฝึก</button>
            )}
            {can('dispute-fail') && (
              <button type="button" disabled={busy} onClick={() => { setForm('dispute'); setText(''); setMessage(null); }}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">โต้แย้งผลประเมิน</button>
            )}
            {app.status === 'IN_PROGRESS' && (
              <button type="button" disabled={busy} onClick={() => { setForm('problem'); setText(''); setMessage(null); }}
                className="rounded-lg border border-border px-5 py-2.5 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">รายงานปัญหา</button>
            )}
          </div>

          {form && (
            <form onSubmit={submitForm} noValidate className="mt-4 space-y-3 rounded-xl border border-border p-4 text-sm">
              <h3 className="font-semibold">{formTitle}</h3>
              {form === 'dispute' && <p className="text-xs text-ink-soft">โต้แย้งได้ภายใน 7 วันหลังรู้ผล และทำได้ 1 ครั้งต่อผลประเมิน 1 รอบ</p>}
              {form === 'problem' && (
                <>
                  <p className="text-xs text-ink-soft">รายงานนี้ส่งถึงอาจารย์ที่ปรึกษาและผู้ดูแลระบบเท่านั้น บริษัทมองไม่เห็น</p>
                  <label className="block font-medium">
                    ประเภทปัญหา
                    <select value={category} onChange={(event) => setCategory(event.target.value as ProblemReportCategory)} className={inputClass}>
                      {PROBLEM_CATEGORIES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select>
                  </label>
                </>
              )}
              <label className="block font-medium">
                {form === 'terminate' ? 'เหตุผล' : form === 'dispute' ? 'เหตุผลที่โต้แย้ง' : 'รายละเอียด'}
                <textarea value={text} onChange={(event) => setText(event.target.value)} rows={4} className={inputClass} />
                <span className="mt-1 block text-xs font-normal text-ink-soft">{text.length}/{form === 'terminate' ? REASON_MAX : LONG_TEXT_MAX}</span>
              </label>
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className="rounded-lg bg-primary px-5 py-2 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
                  {busy ? 'กำลังส่ง…' : 'ส่ง'}
                </button>
                <button type="button" onClick={() => setForm(null)} className="rounded-lg border border-border px-5 py-2 font-semibold hover:bg-surface-muted">ยกเลิก</button>
              </div>
            </form>
          )}
        </section>
      )}

      <section aria-labelledby="timeline-title" className="mt-8">
        <h2 id="timeline-title" className="text-lg font-bold">ประวัติสถานะ</h2>
        {app.timeline.length === 0 ? (
          <p className="mt-2 text-sm text-ink-soft">ยังไม่มีประวัติ</p>
        ) : (
          <ol className="mt-3 space-y-3 border-l-2 border-border pl-4">
            {app.timeline.map((entry, index) => (
              <li key={`${entry.occurred_at}-${index}`} className="text-sm">
                <p className="font-medium">{statusView(APPLICATION_STATUS, entry.to_status).label}</p>
                <p className="text-xs text-ink-soft">
                  {formatDateTime(entry.occurred_at)} · {ACTOR_LABEL[entry.actor_role] ?? entry.actor_role}
                </p>
                {entry.reason && <p className="mt-1 text-ink-soft">เหตุผล: {entry.reason}</p>}
              </li>
            ))}
          </ol>
        )}
      </section>
    </main>
  );
}
