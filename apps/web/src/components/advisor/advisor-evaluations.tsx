'use client';

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  AcademicResult, AcademicResultRequest, AdvisorApplicationItem, AdvisorDisputeAction, AdvisorDisputeItem, ApplicationStatus, Paginated,
} from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import {
  ApplicationSummary, type Message, NOTE_MAX, PAGE_SIZE, Pager, failure, inputClass, primaryButton, secondaryButton,
} from '@/components/advisor/advisor-ui';
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
 * 2. บันทึกผลทางวิชาการ — `GET /advisor/applications?status=` → `POST /advisor/applications/{id}/academic-result`
 */
export function AdvisorEvaluations() {
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ประเมินผลการฝึกงาน</h1>
      <p className="mt-2 text-sm text-ink-soft">ตัดสินคำโต้แย้งผลประเมินของนักศึกษา และบันทึกผลทางวิชาการเมื่อการฝึกงานสิ้นสุด</p>
      <DisputeQueue />
      <AcademicResults />
    </main>
  );
}

function DisputeQueue() {
  const { request } = useAuth();
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<AdvisorDisputeItem> | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notes, setNotes] = useState<Record<string, string>>({});

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
      setList(await request<Paginated<AdvisorDisputeItem>>(`/advisor/disputes?${query.toString()}`));
    } catch (cause) {
      setList(null);
      setMessage({ tone: 'error', text: failure(cause) });
    }
  }, [request, page]);

  useEffect(() => { void load(); }, [load]);

  async function decide(item: AdvisorDisputeItem, action: AdvisorDisputeAction) {
    const question = action === 'request-reevaluation'
      ? `ให้บริษัทประเมิน ${item.student_name} ใหม่? (ประเมินซ้ำได้ 1 รอบ)`
      : `ยืนยันผลไม่ผ่านของ ${item.student_name}?`;
    if (!window.confirm(question)) return;
    const note = (notes[item.id] ?? '').trim();
    if (note.length > NOTE_MAX) { setMessage({ tone: 'error', text: `หมายเหตุต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }
    setBusyId(item.id);
    setMessage(null);
    try {
      await request(`/advisor/applications/${encodeURIComponent(item.id)}/actions/${action}`, { method: 'POST', body: note ? { note } : {} });
      setMessage({
        tone: 'success',
        text: action === 'request-reevaluation' ? `ส่งให้บริษัทประเมิน ${item.student_name} ใหม่แล้ว` : `ยืนยันผลไม่ผ่านของ ${item.student_name} แล้ว บันทึกผลวิชาได้ในส่วนด้านล่าง`,
      });
    } catch (cause) {
      setMessage({ tone: 'error', text: failure(cause) });
    } finally {
      setBusyId(null);
      await load();
    }
  }

  return (
    <section aria-labelledby="disputes-title" className="mt-8">
      <h2 id="disputes-title" className="text-xl font-semibold">คำโต้แย้งผลประเมิน</h2>
      {message && <div className="mt-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {list && list.data.length === 0 && <p className="mt-3 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">ไม่มีคำโต้แย้งที่รอตัดสิน</p>}
      <ul className="mt-3 space-y-4">
        {list?.data.map((item) => (
          <li key={item.id} className="rounded-xl border border-border bg-surface p-5">
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
              <textarea value={notes[item.id] ?? ''} onChange={(event) => setNotes((current) => ({ ...current, [item.id]: event.target.value }))} rows={2} className={inputClass} />
            </label>
            <div className="mt-3 flex flex-wrap gap-3">
              <button type="button" disabled={busyId === item.id} onClick={() => void decide(item, 'request-reevaluation')} className={primaryButton}>ให้บริษัทประเมินใหม่</button>
              <button type="button" disabled={busyId === item.id} onClick={() => void decide(item, 'uphold-fail')} className={secondaryButton}>ยืนยันผลไม่ผ่าน</button>
            </div>
          </li>
        ))}
      </ul>
      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </section>
  );
}

function AcademicResults() {
  const { request } = useAuth();
  const [status, setStatus] = useState<ApplicationStatus>('EVALUATED_PASS');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<AdvisorApplicationItem> | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [result, setResult] = useState<AcademicResult>('ACADEMIC_PASS');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const query = new URLSearchParams({ status, page: String(page), page_size: String(PAGE_SIZE) });
      setList(await request<Paginated<AdvisorApplicationItem>>(`/advisor/applications?${query.toString()}`));
    } catch (cause) {
      setList(null);
      setMessage({ tone: 'error', text: failure(cause) });
    }
  }, [request, status, page]);

  useEffect(() => { void load(); }, [load]);

  const pending = list?.data.filter((app) => !app.academic_result) ?? [];
  const recorded = list?.data.filter((app) => app.academic_result) ?? [];

  function open(app: AdvisorApplicationItem) {
    setEditing(app.id);
    setResult(allowedResults(app.status)[0]);
    setNote('');
    setMessage(null);
  }

  async function submit(event: FormEvent, app: AdvisorApplicationItem) {
    event.preventDefault();
    const value = note.trim();
    if (value.length > NOTE_MAX) { setMessage({ tone: 'error', text: `หมายเหตุต้องไม่เกิน ${NOTE_MAX} ตัวอักษร` }); return; }
    if (!window.confirm(`บันทึกผล "${ACADEMIC_LABEL[result]}" ให้ ${app.student_name}? บันทึกแล้วแก้ไม่ได้`)) return;
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
      <p className="mt-1 text-sm text-ink-soft">ถ้าบริษัทประเมินไม่ผ่าน บันทึกได้เฉพาะ "ไม่ผ่านรายวิชา" หรือ "ต้องฝึกซ้ำ" • บันทึกได้ครั้งเดียว รายการที่บันทึกแล้วแยกไว้ด้านล่าง</p>
      <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl bg-surface-muted p-4">
        <FilterSelect label="ผลจากบริษัท" value={status} onChange={(value) => { setStatus(value as ApplicationStatus); setPage(1); setEditing(null); }} options={RECORDABLE} />
      </div>
      {message && <div className="mt-3"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {list && list.data.length === 0 && <p className="mt-3 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">ไม่มีรายการในสถานะนี้</p>}
      {pending.length > 0 && <h3 className="mt-6 text-base font-semibold">รอบันทึกผล ({pending.length})</h3>}
      {list && list.data.length > 0 && pending.length === 0 && status !== 'COMPLETED' && (
        <p className="mt-3 rounded-xl bg-surface-muted p-6 text-center text-sm text-ink-soft">บันทึกผลครบทุกรายการในหน้านี้แล้ว</p>
      )}
      <ul className="mt-3 space-y-4">
        {pending.map((app) => (
          <li key={app.id} className="rounded-xl border border-border bg-surface p-5">
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
                  <textarea value={note} onChange={(event) => setNote(event.target.value)} rows={2} className={inputClass} />
                </label>
                <div className="flex gap-3">
                  <button type="submit" disabled={busy} className={primaryButton}>{busy ? 'กำลังบันทึก…' : 'บันทึกผล'}</button>
                  <button type="button" onClick={() => setEditing(null)} className={secondaryButton}>ยกเลิก</button>
                </div>
              </form>
            ) : (
              <div className="mt-4"><button type="button" onClick={() => open(app)} className={primaryButton}>บันทึกผลวิชา</button></div>
            )}
          </li>
        ))}
      </ul>
      {recorded.length > 0 && (
        <>
          <h3 className="mt-8 text-base font-semibold">บันทึกผลแล้ว ({recorded.length})</h3>
          <ul className="mt-3 space-y-4">
            {recorded.map((app) => (
              <li key={app.id} className="rounded-xl border border-border bg-surface-muted p-5">
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
      {list && <Pager page={page} total={list.meta.total} onPage={setPage} />}
    </section>
  );
}
