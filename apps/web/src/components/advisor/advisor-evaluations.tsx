'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  AcademicResult, AcademicResultRequest, AdvisorApplicationItem, AdvisorDisputeItem, ApplicationStatus, Paginated,
} from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import {
  ApplicationSummary, type Message, NOTE_MAX, PAGE_SIZE, Pager, failure, inputClass, primaryButton, secondaryButton,
} from '@/components/advisor/advisor-ui';
import { useAdvisorDisputeDecision } from '@/components/advisor/advisor-dispute-decision';
import { formatDate } from '@/components/student/application-ui';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';

/** สถานะที่อาจารย์บันทึกผลวิชาได้ (Lifecycle `allowedAcademicResults`) */
const RECORDABLE: Array<[ApplicationStatus, string]> = [
  ['EVALUATED_PASS', 'บริษัทประเมินผ่าน'],
  ['EVALUATED_FAIL', 'บริษัทประเมินไม่ผ่าน'],
  ['TERMINATED', 'ยุติกลางคัน'],
  ['NO_EVALUATION', 'บริษัทไม่ประเมิน'],
  ['COMPLETED', 'บันทึกผลแล้ว (เสร็จสิ้น)'],
];

/** `COMPLETED` = บันทึกผลแล้วเสมอ จึงไม่อยู่ในตัวเลือกของ "รอบันทึกผล" */
const PENDING_STATUSES = RECORDABLE.filter(([value]) => value !== 'COMPLETED');

type View = 'pending' | 'recorded';
const VIEWS: Array<[View, string]> = [
  ['pending', 'รอบันทึกผล'],
  ['recorded', 'บันทึกผลแล้ว'],
];

/** `academic_result` มีเมื่อบันทึกแล้ว (PM ตัดสิน 2026-11-22) — TERMINATED / NO_EVALUATION ยังอยู่สถานะเดิมหลังบันทึก จึงต้องแยกด้วยฟิลด์นี้ */
const ACADEMIC_TONE: Record<AcademicResult, StatusTone> = {
  ACADEMIC_PASS: 'success',
  ACADEMIC_FAIL: 'danger',
  REPEAT_REQUIRED: 'warning',
};

const ACADEMIC_LABEL: Record<AcademicResult, string> = {
  ACADEMIC_PASS: 'ผ่านรายวิชา',
  ACADEMIC_FAIL: 'ไม่ผ่านรายวิชา',
  REPEAT_REQUIRED: 'ต้องฝึกซ้ำ',
};

/** ห้ามเปลี่ยน FAIL ของบริษัทเป็น PASS (README 5.2, UAT-21) — ตรงกับ Guard ฝั่งเซิร์ฟเวอร์ */
function allowedResults(status: ApplicationStatus): AcademicResult[] {
  if (status === 'EVALUATED_FAIL') return ['ACADEMIC_FAIL', 'REPEAT_REQUIRED'];
  return ['ACADEMIC_PASS', 'ACADEMIC_FAIL', 'REPEAT_REQUIRED'];
}

/**
 * หน้าอาจารย์ประเมินผล (README §5.2 / §8 Advisor Dashboard)
 * 1. คิวคำโต้แย้งผล `FAIL` — `GET /advisor/disputes` → `request-reevaluation` (ให้บริษัทประเมินซ้ำ 1 รอบ) หรือ `uphold-fail`
 * 2. บันทึกผลทางวิชาการ — `GET /advisor/applications?status=&academic_recorded=false|true` → `POST /advisor/applications/{id}/academic-result`
 */
export function AdvisorEvaluations() {
  const [tab, setTab] = useState<View | 'disputes'>('disputes');
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get('view') === 'pending' || params.get('status')) setTab('pending');
  }, []);
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ประเมินผลการฝึกงาน</h1>
      <p className="mt-2 text-sm text-ink-soft">ตัดสินคำโต้แย้งผลประเมินของนักศึกษา และบันทึกผลทางวิชาการเมื่อการฝึกงานสิ้นสุด</p>
      <div className="mt-5 flex flex-wrap gap-2" role="group" aria-label="งานประเมินผล">
        {([['disputes', 'คำโต้แย้ง'], ...VIEWS] as const).map(([key, label]) => <button key={key} aria-pressed={tab === key} className="rounded-full border border-border px-4 py-2 text-sm aria-pressed:bg-primary-soft" onClick={() => setTab(key)}>{label}</button>)}
      </div>
      {tab === 'disputes' ? <DisputeQueue /> : <AcademicResults key={tab} view={tab} />}
    </main>
  );
}

function EvaluationPicker({ rows, selected, onSelect }: { rows: AdvisorApplicationItem[]; selected?: string; onSelect: (id: string) => void }) {
  return <ul aria-label="เลือกใบสมัครที่จะประเมิน" className="hidden min-w-0 self-start divide-y divide-border lg:block">
    {rows.map((app) => <li key={app.id}><button type="button" aria-pressed={selected === app.id} onClick={() => onSelect(app.id)}
      className="w-full rounded-lg p-3 text-left text-sm [overflow-wrap:anywhere] aria-pressed:bg-primary-soft">
      <strong className="block">{app.student_name}</strong>{app.job_title} · {app.company_name}
    </button></li>)}
  </ul>;
}

function DisputeQueue() {
  const { request } = useAuth();
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<AdvisorDisputeItem> | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      setList(await request<Paginated<AdvisorDisputeItem>>(`/advisor/disputes?${query.toString()}`));
      setLoadError(null);
    } catch (cause) {
      setList(null);
      setLoadError(failure(cause));
    }
  }, [request, page]);

  useEffect(() => { void load(); }, [load]);

  const selected = list?.data.find((item) => item.id === selectedId) ?? list?.data[0];
  const { busyId, decide, message } = useAdvisorDisputeDecision(load);

  return (
    <section aria-labelledby="disputes-title" className="mt-8">
      <h2 id="disputes-title" className="text-xl font-semibold">คำโต้แย้งผลประเมิน</h2>
      {loadError && <div className="mt-3"><Notice tone="error">{loadError}</Notice></div>}
      {message && <div className="mt-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {list && list.data.length === 0 && <p className="mt-3 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">ไม่มีคำโต้แย้งที่รอตัดสิน</p>}
      <div className="mt-3 grid gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
      <EvaluationPicker rows={list?.data ?? []} selected={selected?.id} onSelect={setSelectedId} />
      <ul className="min-w-0 space-y-4">
        {list?.data.map((item) => (
          <li key={item.id} className={`rounded-xl border border-border bg-surface p-5 ${item.id === selected?.id ? '' : 'lg:hidden'}`}>
            <ApplicationSummary app={item} />
            <dl className="mt-4 grid gap-3 rounded-xl bg-surface-muted p-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-xs text-ink-soft">ผลประเมินของบริษัท{item.evaluation ? ` (รอบที่ ${item.evaluation.round} · ${formatDate(item.evaluation.evaluated_at)})` : ''}</dt>
                <dd className="mt-1 whitespace-pre-line">{item.evaluation?.reason ?? 'ไม่พบผลประเมิน'}</dd>
              </div>
              <div>
                <dt className="text-xs text-ink-soft">คำโต้แย้งของนักศึกษา ({formatDate(item.dispute.created_at)})</dt>
                <dd className="mt-1 whitespace-pre-line">{item.dispute.statement}</dd>
              </div>
            </dl>
            <label className="mt-4 block text-sm font-medium">
              หมายเหตุถึงบริษัทและนักศึกษา (ไม่บังคับ)
              <textarea maxLength={2000} value={notes[item.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} rows={2} className={inputClass} />
            </label>
            <div className="mt-3 flex flex-wrap gap-3">
              {item.evaluation?.round === 1 && (
                <button type="button" disabled={busyId !== null} onClick={() => void decide(item, 'request-reevaluation', notes[item.id] ?? '')} className={primaryButton}>ให้บริษัทประเมินใหม่</button>
              )}
              <button type="button" disabled={busyId !== null} onClick={() => void decide(item, 'uphold-fail', notes[item.id] ?? '')} className={secondaryButton}>ยืนยันผลไม่ผ่าน</button>
            </div>
          </li>
        ))}
      </ul></div>
      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </section>
  );
}

function AcademicResults({ view }: { view: View }) {
  const { request } = useAuth();
  const [status, setStatus] = useState<ApplicationStatus>('EVALUATED_PASS');
  const [selectedId, setSelectedId] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<AdvisorApplicationItem> | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [result, setResult] = useState<AcademicResult | ''>('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      // กรองที่เซิร์ฟเวอร์ ⇒ จำนวนและการแบ่งหน้าตรงกับรายการที่แสดง
      const query = new URLSearchParams({
        status,
        academic_recorded: String(view === 'recorded'),
        page: String(page),
        page_size: String(PAGE_SIZE),
      });
      setList(await request<Paginated<AdvisorApplicationItem>>(`/advisor/applications?${query.toString()}`));
    } catch (cause) {
      setList(null);
      setMessage({ tone: 'error', text: failure(cause) });
    }
  }, [request, view, status, page]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const preset = new URLSearchParams(window.location.search).get('status');
    if (PENDING_STATUSES.some(([key]) => key === preset)) setStatus(preset as ApplicationStatus);
  }, []);

  const selected = list?.data.find((app) => app.id === selectedId) ?? list?.data[0];
  const pending = view === 'pending' ? list?.data ?? [] : [];
  const recorded = view === 'recorded' ? list?.data ?? [] : [];
  const total = list?.meta.total ?? 0;

  function open(app: AdvisorApplicationItem) {
    setEditing(app.id);
    setResult('');
    setNote('');
    setMessage(null);
  }

  async function submit(event: FormEvent, app: AdvisorApplicationItem) {
    event.preventDefault();
    const value = note.trim();
    if (value.length > NOTE_MAX) { setMessage({ tone: 'error', text: `หมายเหตุต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }
    if (!result || !allowedResults(app.status).includes(result)) return;
    if (!window.confirm(`บันทึกผล "${ACADEMIC_LABEL[result]}" ให้ ${app.student_name}?${value ? `\nหมายเหตุ: ${value}` : ''} บันทึกแล้วแก้ไม่ได้`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const body: AcademicResultRequest = { academic_result: result, ...(value ? { note: value } : {}) };
      const saved = await request<AdvisorApplicationItem>(`/advisor/applications/${encodeURIComponent(app.id)}/academic-result`, { method: 'POST', body });
      setEditing(null);
      const label = ACADEMIC_LABEL[saved.academic_result ?? result];
      setMessage({
        tone: 'success',
        text: saved.status === 'COMPLETED'
          ? `บันทึกผล "${label}" ของ ${app.student_name} แล้ว การฝึกงานนี้เสร็จสิ้น`
          : `บันทึกผล "${label}" ของ ${app.student_name} แล้ว`,
      });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
    } finally {
      setBusy(false);
      await load();
    }
  }

  return (
    <section aria-labelledby="academic-title" className="mt-12">
      <h2 id="academic-title" className="text-xl font-semibold">บันทึกผลทางวิชาการ</h2>
      <p className="mt-1 text-sm text-ink-soft">ถ้าบริษัทประเมินไม่ผ่าน บันทึกได้เฉพาะ "ไม่ผ่านรายวิชา" หรือ "ต้องฝึกซ้ำ" • บันทึกได้ครั้งเดียว ดูรายการที่ผ่านมาได้ในแท็บบันทึกผลแล้ว</p>
      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-surface-muted p-4">
        <FilterSelect label="สถานะใบสมัคร" value={status} onChange={(value) => { setStatus(value as ApplicationStatus); setPage(1); setEditing(null); }}
          options={view === 'pending' ? PENDING_STATUSES : RECORDABLE} />
      </div>
      {message && <div className="mt-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {list && list.data.length === 0 && (
        <p className="mt-3 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">
          {view === 'pending' ? 'ไม่มีรายการรอบันทึกผลในสถานะนี้' : 'ยังไม่มีรายการที่บันทึกผลในสถานะนี้'}
        </p>
      )}
      <div className="mt-4 grid items-start gap-4 lg:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
        <EvaluationPicker rows={list?.data ?? []} selected={selected?.id} onSelect={(id) => { setSelectedId(id); setEditing(null); }} />
        <div className="min-w-0">
      {pending.length > 0 && <h3 className="mt-6 text-base font-semibold">รอบันทึกผล ({total})</h3>}
      <ul className="mt-3 space-y-4">
        {pending.map((app) => (
          <li key={app.id} className={`rounded-xl border border-border bg-surface p-5 ${app.id === selected?.id ? '' : 'lg:hidden'}`}>
            <ApplicationSummary app={app} />
            {editing === app.id ? (
              <form onSubmit={(event) => void submit(event, app)} noValidate className="mt-4 space-y-3 rounded-xl bg-surface-muted p-4 text-sm">
                <fieldset>
                  <legend className="font-medium">ผลทางวิชาการ</legend>
                  <div className="mt-2 flex flex-wrap gap-4">
                    {allowedResults(app.status).map((value) => (
                      <label key={value} className="inline-flex items-center gap-2">
                        <input type="radio" name={`result-${app.id}`} value={value} checked={result === value} onChange={() => setResult(value)} />
                        {ACADEMIC_LABEL[value]}
                      </label>
                    ))}
                  </div>
                </fieldset>
                <label className="block font-medium">
                  หมายเหตุ (ไม่บังคับ)
                  <textarea maxLength={NOTE_MAX} value={note} onChange={(event) => setNote(event.target.value)} rows={2} className={inputClass} />
                </label>
                <div className="flex gap-3">
                  <button type="submit" disabled={busy || !result} className={primaryButton}>{busy ? 'กำลังบันทึก…' : 'บันทึกผล'}</button>
                  <button type="button" onClick={() => setEditing(null)} className={secondaryButton}>ยกเลิก</button>
                </div>
              </form>
            ) : (
              <RecordButton app={app} onOpen={() => open(app)} />
            )}
          </li>
        ))}
      </ul>
      {recorded.length > 0 && (
        <>
          <h3 className="mt-6 text-base font-semibold">บันทึกผลแล้ว ({total})</h3>
          <ul className="mt-3 space-y-4">
            {recorded.map((app) => (
              <li key={app.id} className={`rounded-xl border border-border bg-surface-muted p-5 ${app.id === selected?.id ? '' : 'lg:hidden'}`}>
                <ApplicationSummary app={app} />
                <p className="mt-4 flex flex-wrap items-center gap-2 text-sm">
                  <span className="text-ink-soft">ผลทางวิชาการ</span>
                  {app.academic_result && <StatusBadge tone={ACADEMIC_TONE[app.academic_result]}>{ACADEMIC_LABEL[app.academic_result]}</StatusBadge>}
                </p>
              </li>
            ))}
          </ul>
        </>
      )}
        </div></div>
      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </section>
  );
}

/** วัน/เวลาแบบไทย เช่น "3 ธ.ค. 2569 14:30 น." */
function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }) + ' น.';
}

/**
 * ปุ่มบันทึกผลวิชา — ผล FAIL ที่ช่วงโต้แย้ง 7 วันยังไม่ปิด (academic_result_available_at ยังไม่ถึง) กดไม่ได้
 * และบอกวันที่บันทึกได้ แทนการกดแล้วได้ข้อผิดพลาด DISPUTE_WINDOW_OPEN
 */
function RecordButton({ app, onOpen }: { app: AdvisorApplicationItem; onOpen: () => void }) {
  const availableAt = app.academic_result_available_at;
  const waiting = availableAt !== undefined && new Date(availableAt).getTime() > Date.now();
  return (
    <div className="mt-4 space-y-2">
      {waiting && (
        <p className="rounded-lg bg-warning-soft px-3 py-2 text-sm text-warning-text">
          อยู่ในช่วงที่นักศึกษาโต้แย้งผลได้ (7 วันหลังบริษัทประเมิน) — บันทึกผลได้ตั้งแต่ {formatDateTime(availableAt)}
        </p>
      )}
      <button type="button" onClick={onOpen} disabled={waiting} className={primaryButton}>บันทึกผลวิชา</button>
    </div>
  );
}
