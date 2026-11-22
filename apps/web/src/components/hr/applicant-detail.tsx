'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { CircleCheck, CircleX } from 'lucide-react';
import type { HrApplicationDetail, HrStartResponse, ResumeUrlResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { HrEvaluationForm } from '@/components/hr/hr-evaluation-form';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApplicationStatusBadge, formatDate } from '@/components/student/application-ui';
import { ApiError } from '@/lib/api';

const MIN_DAYS = 30;          // ระยะฝึก ≥ 30 วัน (README 5.2.2) — Lifecycle ตรวจจริงอีกชั้น
const REASON_MAX = 2000;

type FormKind = 'accept' | 'reject' | 'rescind-offer' | 'start' | 'terminate' | 'revoke-certificate';
type Message = { tone: 'error' | 'success'; text: string };

const FORM_TITLE: Record<FormKind, string> = {
  accept: 'ส่งข้อเสนอให้ผู้สมัคร',
  reject: 'ปฏิเสธใบสมัคร',
  'rescind-offer': 'ถอนข้อเสนอ',
  start: 'ยืนยันว่าเริ่มงานจริง',
  terminate: 'ยุติการฝึกงาน',
  'revoke-certificate': 'เพิกถอนใบรับรอง',
};

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

/** วันนี้ตามเวลากรุงเทพ (YYYY-MM-DD) — `en-CA` ให้รูปแบบ ISO */
const todayBangkok = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

function failure(cause: unknown): string {
  return cause instanceof ApiError ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>;
}

export function ApplicantDetail() {
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const [app, setApp] = useState<HrApplicationDetail | null>(null);
  const [loadError, setLoadError] = useState<{ missing: boolean; text: string } | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [form, setForm] = useState<FormKind | null>(null);
  const [text, setText] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [actualDate, setActualDate] = useState('');

  const load = useCallback(async () => {
    try {
      setApp(await request<HrApplicationDetail>(`/hr/applications/${encodeURIComponent(id)}`));
      setLoadError(null);
    } catch (cause) {
      // HR เปิดใบสมัครของบริษัทอื่น ⇒ 403 NOT_OWNER_OF_RESOURCE (ไม่ใช่ 404 — api-contract §7.3)
      const missing = cause instanceof ApiError && (cause.status === 404 || cause.status === 403);
      setLoadError({ missing, text: missing ? 'ไม่พบใบสมัครนี้ในบริษัทของคุณ' : failure(cause) });
    }
  }, [request, id]);

  useEffect(() => {
    if (!id) { setLoadError({ missing: true, text: 'ไม่พบใบสมัครนี้ในบริษัทของคุณ' }); return; }
    setApp(null);
    void load();
  }, [id, load]);

  function openForm(kind: FormKind) {
    setForm(kind);
    setText('');
    setMessage(null);
    // ค่าเริ่มต้นของฟอร์ม: ใช้วันที่ตามข้อเสนอเดิมถ้ามี
    setStartDate(app?.start_date ?? '');
    setEndDate(app?.end_date ?? '');
    setActualDate(todayBangkok());
  }

  /** เรียก action แล้วโหลดสถานะจริงใหม่เสมอ (แม้ error เพราะสถานะอาจเปลี่ยนไปแล้ว — 409) */
  async function act(action: string, body: unknown, success: string) {
    setBusy(true);
    setMessage(null);
    try {
      const response = await request<HrStartResponse | undefined>(`/hr/applications/${encodeURIComponent(id)}/actions/${action}`, { method: 'POST', body });
      setForm(null);
      await load();
      const warning = response?.warning === 'NO_CERTIFICATE_ELIGIBLE'
        ? ' แต่ระยะฝึกจริงสั้นกว่า 30 วัน นักศึกษาจะไม่มีสิทธิ์รับ E-Certificate' : '';
      setMessage({ tone: 'success', text: success + warning });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
      await load();
    } finally { setBusy(false); }
  }

  /** ออกใบรับรอง — ไม่มี body; ออกได้ใบเดียวต่อใบสมัคร ตรวจ PASS และฝึกจริง ≥ 30 วันที่เซิร์ฟเวอร์ */
  async function issueCertificate() {
    if (!window.confirm('ออก E-Certificate ให้นักศึกษาคนนี้? ออกได้เพียงใบเดียวต่อใบสมัคร และถ้าเพิกถอนแล้วจะออกใหม่ไม่ได้')) return;
    setBusy(true);
    setMessage(null);
    try {
      await request(`/hr/applications/${encodeURIComponent(id)}/certificate`, { method: 'POST' });
      await load();
      setMessage({ tone: 'success', text: 'ออก E-Certificate แล้ว นักศึกษาดาวน์โหลดได้จากหน้าของตน' });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
      await load();
    } finally { setBusy(false); }
  }

  async function revokeCertificate(certificateId: string, reason: string) {
    setBusy(true);
    setMessage(null);
    try {
      await request(`/hr/certificates/${encodeURIComponent(certificateId)}/actions/revoke`, { method: 'POST', body: { reason } });
      setForm(null);
      await load();
      setMessage({ tone: 'success', text: 'เพิกถอนใบรับรองแล้ว' });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
      await load();
    } finally { setBusy(false); }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    const bad = (problem: string) => setMessage({ tone: 'error', text: problem });
    if (value.length > REASON_MAX) return bad(`ข้อความต้องไม่เกิน ${REASON_MAX} ตัวอักษร`);

    if (form === 'revoke-certificate') {
      if (!app?.certificate) return bad('ไม่พบใบรับรองของใบสมัครนี้');
      if (!value) return bad('กรุณาระบุเหตุผลที่เพิกถอนใบรับรอง');
      void revokeCertificate(app.certificate.id, value);
    } else if (form === 'accept') {
      if (!startDate || !endDate) return bad('กรุณาระบุวันเริ่มและวันสิ้นสุด');
      if (daysBetween(startDate, endDate) < MIN_DAYS) return bad(`ระยะฝึกงานต้องไม่น้อยกว่า ${MIN_DAYS} วัน`);
      void act('accept', { start_date: startDate, end_date: endDate }, 'ส่งข้อเสนอแล้ว รอนักศึกษายืนยัน');
    } else if (form === 'reject') {
      void act('reject', value ? { reason: value } : {}, 'ปฏิเสธใบสมัครแล้ว');
    } else if (form === 'rescind-offer') {
      if (!value) return bad('กรุณาระบุเหตุผลที่ถอนข้อเสนอ');
      void act('rescind-offer', { reason: value }, 'ถอนข้อเสนอแล้ว');
    } else if (form === 'start') {
      if (!actualDate) return bad('กรุณาระบุวันที่เริ่มงานจริง');
      if (actualDate > todayBangkok()) return bad('วันที่เริ่มงานจริงเป็นวันในอนาคตไม่ได้');
      if (startDate && endDate && daysBetween(startDate, endDate) <= 0) return bad('วันสิ้นสุดต้องอยู่หลังวันเริ่ม');
      void act('start', {
        actual_start_date: actualDate,
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
      }, 'ยืนยันการเริ่มงานแล้ว');
    } else if (form === 'terminate') {
      if (!value) return bad('กรุณาระบุเหตุผลที่ยุติการฝึก');
      if (actualDate > todayBangkok()) return bad('วันสิ้นสุดจริงเป็นวันในอนาคตไม่ได้');
      void act('terminate', { reason: value, ...(actualDate ? { actual_end_date: actualDate } : {}) }, 'ยุติการฝึกแล้ว');
    }
  }

  async function openResume() {
    setMessage(null);
    try {
      const { url } = await request<ResumeUrlResponse>(`/hr/applications/${encodeURIComponent(id)}/resume`);
      window.open(url, '_blank', 'noopener');
    } catch (cause) {
      // นักศึกษาลบไฟล์แล้ว ⇒ 404 + RESUME_DELETED_BY_STUDENT (สิทธิ์ลบของเจ้าของข้อมูล)
      const deleted = cause instanceof ApiError && cause.issues.includes('RESUME_DELETED_BY_STUDENT');
      setMessage({ tone: 'error', text: deleted ? 'นักศึกษาลบเรซูเม่ไฟล์นี้แล้ว' : failure(cause) });
    }
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">{loadError.missing ? 'ไม่พบใบสมัครนี้' : 'โหลดใบสมัครไม่สำเร็จ'}</h1>
        <p className="mt-2 text-sm text-ink-soft">{loadError.text}</p>
        <Link href="/hr/applicants" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปรายการผู้สมัคร</Link>
      </main>
    );
  }
  if (!app) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const can = (action: string) => app.available_actions.includes(action);
  const buttons: Array<[FormKind, string, boolean]> = [
    ['accept', 'ส่งข้อเสนอ', true], ['reject', 'ปฏิเสธ', false], ['rescind-offer', 'ถอนข้อเสนอ', false],
    ['start', 'ยืนยันเริ่มงาน', true], ['terminate', 'ยุติการฝึก', false],
  ];
  const visibleButtons = buttons.filter(([kind]) => can(kind));
  const certificate = app.certificate;
  const canRevoke = certificate?.status === 'VALID';
  const showActions = visibleButtons.length > 0 || Boolean(app.accept_blocked_reason) || can('evaluate') || can('certificate') || canRevoke;
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/hr/applicants" className="text-sm font-medium text-primary hover:underline">← ผู้สมัครของบริษัท</Link>

      <header className="mt-3 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-3xl font-semibold">{app.job_title}</h1>
          <p className="mt-1 text-ink-soft">{app.profile?.full_name || `ผู้สมัคร #${app.student_user_id.slice(0, 8)}`}</p>
        </div>
        <ApplicationStatusBadge status={app.status} />
      </header>

      {app.frozen && <div className="mt-4"><Notice tone="error">ประกาศนี้ถูกระงับชั่วคราว จึงยังส่งข้อเสนอไม่ได้จนกว่าผู้ดูแลระบบจะตรวจสอบเสร็จ</Notice></div>}
      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <dl className="mt-6 grid grid-cols-2 gap-4 rounded-xl bg-surface-muted p-4 sm:grid-cols-3">
        <Fact label="สมัครเมื่อ">{formatDate(app.created_at)}</Fact>
        <Fact label="เริ่มฝึก (ตามข้อเสนอ)">{app.start_date ? formatDate(app.start_date) : '-'}</Fact>
        <Fact label="สิ้นสุด (ตามข้อเสนอ)">{app.end_date ? formatDate(app.end_date) : '-'}</Fact>
        {app.actual_start_date && <Fact label="เริ่มฝึกจริง">{formatDate(app.actual_start_date)}</Fact>}
        {app.actual_end_date && <Fact label="สิ้นสุดจริง">{formatDate(app.actual_end_date)}</Fact>}
        {app.major_mismatch && <Fact label="สาขา">ไม่ตรงกับที่ประกาศระบุ</Fact>}
      </dl>

      <section aria-labelledby="profile-title" className="mt-8">
        <h2 id="profile-title" className="text-lg font-semibold">โปรไฟล์ผู้สมัคร</h2>
        {app.profile ? (
          <div className="mt-3 space-y-3 text-sm">
            <p><span className="text-ink-soft">สาขา/ชั้นปี:</span> {app.profile.major} ปี {app.profile.year_level}</p>
            {app.profile.headline && <p className="font-medium">{app.profile.headline}</p>}
            {app.profile.bio && <p className="whitespace-pre-line text-ink-soft">{app.profile.bio}</p>}
            {app.profile.skills.length > 0 && (
              <ul className="flex flex-wrap gap-2">
                {app.profile.skills.map((skill) => <li key={skill} className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-soft">{skill}</li>)}
              </ul>
            )}
            {app.profile.portfolio_url && (
              <p><a href={app.profile.portfolio_url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">ดูผลงาน</a></p>
            )}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-soft">ยังไม่มีข้อมูลโปรไฟล์ที่แสดงได้</p>
        )}
        {app.cover_letter && (
          <div className="mt-4">
            <h3 className="font-semibold">จดหมายสมัคร</h3>
            <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">{app.cover_letter}</p>
          </div>
        )}
        <button type="button" onClick={() => void openResume()} className="mt-4 rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted">
          เปิดเรซูเม่
        </button>
      </section>

      {app.evaluation && (
        <section aria-labelledby="evaluation-title" className="mt-8">
          <h2 id="evaluation-title" className="text-lg font-semibold">ผลประเมิน</h2>
          <p className="mt-2 flex flex-wrap items-center gap-2 text-sm">
            {/* ป้ายสถานะกลางตาม design.md ชิ้นที่ 1: ไอคอน + ข้อความ ไม่ใช้สีอย่างเดียว */}
            {app.evaluation.result === 'PASS'
              ? <StatusBadge tone="success" icon={CircleCheck}>ประเมินผ่าน</StatusBadge>
              : <StatusBadge tone="danger" icon={CircleX}>ประเมินไม่ผ่าน</StatusBadge>}
            <span className="text-ink-soft">รอบที่ {app.evaluation.round} · {formatDate(app.evaluation.evaluated_at)}</span>
          </p>
          {app.evaluation.reason && <p className="mt-2 whitespace-pre-line text-sm text-ink-soft">เหตุผล: {app.evaluation.reason}</p>}
          {app.evaluation.score_note && <p className="mt-1 whitespace-pre-line text-sm text-ink-soft">หมายเหตุ: {app.evaluation.score_note}</p>}
        </section>
      )}

      {certificate && (
        <section aria-labelledby="certificate-title" className="mt-8">
          <h2 id="certificate-title" className="text-lg font-semibold">E-Certificate</h2>
          <dl className="mt-3 grid grid-cols-2 gap-4 rounded-xl bg-surface-muted p-4 sm:grid-cols-4">
            <Fact label="รหัสใบรับรอง">{certificate.certificate_code}</Fact>
            <Fact label="สถานะ">
              {certificate.status === 'VALID'
                ? <StatusBadge tone="success" icon={CircleCheck}>ใช้ได้</StatusBadge>
                : <StatusBadge tone="danger" icon={CircleX}>ถูกเพิกถอน</StatusBadge>}
            </Fact>
            <Fact label="ฝึกจริง">{certificate.actual_days} วัน</Fact>
            <Fact label="ออกเมื่อ">{formatDate(certificate.issued_at)}</Fact>
          </dl>
          {certificate.status === 'REVOKED' && (
            <p className="mt-2 text-sm text-ink-soft">ใบนี้ถูกเพิกถอนแล้ว นักศึกษาดาวน์โหลดไม่ได้ และออกใบใหม่ให้ใบสมัครนี้ไม่ได้</p>
          )}
        </section>
      )}

      {showActions && (
        <section aria-labelledby="actions-title" className="mt-8">
          <h2 id="actions-title" className="text-lg font-semibold">ดำเนินการ</h2>
          {app.accept_blocked_reason && (
            <p className="mt-1 text-sm text-warning-text">
              ส่งข้อเสนอไม่ได้ในขณะนี้: {app.accept_blocked_reason === 'ALREADY_CONFIRMED_ELSEWHERE' ? 'นักศึกษายืนยันฝึกงานกับที่อื่นแล้ว' : app.accept_blocked_reason === 'JOB_FROZEN' ? 'ประกาศถูกระงับชั่วคราว' : app.accept_blocked_reason}
            </p>
          )}
          {can('evaluate') && <HrEvaluationForm applicationId={app.id} status={app.status} studentLabel={app.student_name} onChanged={load} />}
          {can('certificate') && <p className="mt-1 text-sm text-ink-soft">ประเมินผ่านและฝึกครบเกณฑ์แล้ว ออก E-Certificate ให้นักศึกษาได้</p>}
          <div className="mt-3 flex flex-wrap gap-3">
            {can('certificate') && (
              <button type="button" disabled={busy} onClick={() => void issueCertificate()}
                className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
                ออกใบรับรอง
              </button>
            )}
            {canRevoke && (
              <button type="button" disabled={busy} onClick={() => openForm('revoke-certificate')}
                className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold text-danger-text hover:bg-danger-soft disabled:opacity-60">
                เพิกถอนใบรับรอง
              </button>
            )}
            {visibleButtons.map(([kind, label, primary]) => (
              <button key={kind} type="button" disabled={busy} onClick={() => openForm(kind)}
                className={`rounded-full px-5 py-2.5 text-sm font-semibold disabled:opacity-60 ${primary ? 'bg-primary text-white hover:bg-primary-hover' : 'border border-border hover:bg-surface-muted'}`}>
                {label}
              </button>
            ))}
          </div>

          {form && (
            <form onSubmit={submit} noValidate className="mt-4 space-y-3 rounded-xl border border-border p-4 text-sm">
              <h3 className="font-semibold">{FORM_TITLE[form]}</h3>
              {form === 'accept' && (
                <>
                  <p className="text-xs text-ink-soft">ระยะฝึกงานต้องไม่น้อยกว่า {MIN_DAYS} วัน การส่งข้อเสนอจะจองโควตาของประกาศ</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block font-medium">วันเริ่ม<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={inputClass} /></label>
                    <label className="block font-medium">วันสิ้นสุด<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={inputClass} /></label>
                  </div>
                </>
              )}
              {form === 'start' && (
                <>
                  <label className="block font-medium">
                    วันที่เริ่มงานจริง
                    <input type="date" value={actualDate} max={todayBangkok()} onChange={(event) => setActualDate(event.target.value)} className={inputClass} />
                  </label>
                  <p className="text-xs text-ink-soft">ปรับวันเริ่ม–สิ้นสุดตามจริงได้ (ถ้าระยะฝึกจริงน้อยกว่า {MIN_DAYS} วัน นักศึกษาจะไม่มีสิทธิ์รับ E-Certificate)</p>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="block font-medium">วันเริ่ม<input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} className={inputClass} /></label>
                    <label className="block font-medium">วันสิ้นสุด<input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} className={inputClass} /></label>
                  </div>
                </>
              )}
              {form === 'terminate' && (
                <label className="block font-medium">
                  วันสิ้นสุดจริง (ไม่ระบุ = วันนี้)
                  <input type="date" value={actualDate} max={todayBangkok()} onChange={(event) => setActualDate(event.target.value)} className={inputClass} />
                </label>
              )}
              {form === 'revoke-certificate' && (
                <p className="text-xs text-ink-soft">การเพิกถอนทำย้อนกลับไม่ได้ และจะออกใบรับรองใหม่ให้ใบสมัครนี้ไม่ได้ หน้าตรวจสอบสาธารณะจะแสดงสถานะ "ถูกเพิกถอน"</p>
              )}
              {(form === 'reject' || form === 'rescind-offer' || form === 'terminate' || form === 'revoke-certificate') && (
                <label className="block font-medium">
                  {form === 'reject' ? 'เหตุผล (ไม่บังคับ)' : 'เหตุผล'}
                  <textarea value={text} onChange={(event) => setText(event.target.value)} rows={3} className={inputClass} />
                  <span className="mt-1 block text-xs font-normal text-ink-soft">{text.length}/{REASON_MAX}</span>
                </label>
              )}
              <div className="flex gap-3">
                <button type="submit" disabled={busy} className="rounded-full bg-primary px-5 py-2 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
                  {busy ? 'กำลังดำเนินการ…' : 'ยืนยัน'}
                </button>
                <button type="button" onClick={() => setForm(null)} className="rounded-full border border-border px-5 py-2 font-semibold hover:bg-surface-muted">ยกเลิก</button>
              </div>
            </form>
          )}
        </section>
      )}

    </main>
  );
}
