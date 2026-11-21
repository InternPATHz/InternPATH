'use client';

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import type { FormEvent } from 'react';
import type { HrJobDetail, JobCategory, JobStatus, JobTag, JobWritableFields, WorkMode } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { EDITABLE_STATUSES, JobStatusBadge } from '@/components/hr/jobs/job-ui';
import { ApiError } from '@/lib/api';
import { HR_JOBS_MOCK, hrJobsApi, missingRequired } from '@/lib/hr-jobs';
import { CATEGORIES } from '@/lib/mock-landing';

const CLOSED_FIELDS = ['quota', 'application_deadline', 'target_majors', 'tag_ids', 'period']; // ประกาศ `CLOSED` แก้ได้เฉพาะเหล่านี้ (api-contract §5.1)

const FIELD_LABEL: Record<string, string> = {
  category: 'สายงาน', job_title: 'ชื่อตำแหน่ง', description: 'รายละเอียดงาน', responsibilities: 'หน้าที่ความรับผิดชอบ', qualifications: 'คุณสมบัติผู้สมัคร',
  location: 'สถานที่ฝึกงาน', work_mode: 'รูปแบบการทำงาน', hours_per_week: 'ชั่วโมงต่อสัปดาห์', allowance: 'เบี้ยเลี้ยง', period: 'ช่วงเวลาฝึกงาน',
  target_majors: 'สาขาที่เปิดรับ', tag_ids: 'Tag ทักษะ', quota: 'จำนวนที่รับ', application_deadline: 'วันปิดรับสมัคร',
};

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-soft';

interface FormState {
  category: string; job_title: string; description: string; responsibilities: string; qualifications: string; location: string;
  contact_notes: string; work_mode: string; hours: string; allowanceType: string; allowanceAmount: string; allowanceText: string;
  periodStart: string; periodEnd: string; majors: string; quota: string; deadline: string; tagIds: string[];
}

const EMPTY: FormState = {
  category: '', job_title: '', description: '', responsibilities: '', qualifications: '', location: '', contact_notes: '', work_mode: '', hours: '',
  allowanceType: '', allowanceAmount: '', allowanceText: '', periodStart: '', periodEnd: '', majors: '', quota: '', deadline: '', tagIds: [],
};

const TAG_MAX = 10; // api-contract §5.4

const parseMajors = (text: string) => [...new Set(text.split(/[,\n]/).map((major) => major.trim()).filter(Boolean))];

function fromJob(job: HrJobDetail): FormState {
  return {
    category: job.category ?? '', job_title: job.job_title ?? '', description: job.description ?? '', responsibilities: job.responsibilities ?? '',
    qualifications: job.qualifications ?? '', location: job.location ?? '', contact_notes: job.contact_notes ?? '', work_mode: job.work_mode ?? '',
    hours: job.hours_per_week === null ? '' : String(job.hours_per_week), allowanceType: job.allowance?.type ?? '',
    allowanceAmount: job.allowance?.amount_thb === undefined ? '' : String(job.allowance.amount_thb), allowanceText: job.allowance?.text ?? '',
    periodStart: job.period.start ?? '', periodEnd: job.period.end ?? '', majors: (job.target_majors ?? []).join(', '),
    quota: job.quota === null ? '' : String(job.quota), deadline: job.application_deadline ?? '',
    tagIds: (job.tags ?? []).map((tag) => tag.id),
  };
}

/** แปลงฟอร์มเป็นฟิลด์ของสัญญา — ข้ามช่องที่ว่าง (DRAFT ไม่ครบได้) */
function toFields(form: FormState): Partial<JobWritableFields> {
  const fields: Partial<JobWritableFields> = {};
  if (form.category) fields.category = form.category as JobCategory;
  for (const key of ['job_title', 'description', 'responsibilities', 'qualifications', 'location', 'contact_notes'] as const) {
    if (form[key].trim()) fields[key] = form[key].trim();
  }
  if (form.work_mode) fields.work_mode = form.work_mode as WorkMode;
  if (form.hours.trim()) fields.hours_per_week = Number(form.hours);
  if (form.allowanceType === 'AMOUNT') {
    fields.allowance = { type: 'AMOUNT', ...(form.allowanceAmount.trim() ? { amount_thb: Number(form.allowanceAmount) } : {}), ...(form.allowanceText.trim() ? { text: form.allowanceText.trim() } : {}) };
  } else if (form.allowanceType === 'NONE') {
    fields.allowance = { type: 'NONE' };
  }
  if (form.periodStart && form.periodEnd) fields.period = { start: form.periodStart, end: form.periodEnd };
  const majors = parseMajors(form.majors);
  if (majors.length > 0) fields.target_majors = majors;
  if (form.quota.trim()) fields.quota = Number(form.quota);
  if (form.deadline) fields.application_deadline = form.deadline;
  if (form.tagIds.length > 0) fields.tag_ids = form.tagIds;
  return fields;
}

/** ฟิลด์ที่เปลี่ยนจากค่าที่โหลดมา (PATCH ส่งเฉพาะที่แก้) */
function changedFields(next: Partial<JobWritableFields>, before: Partial<JobWritableFields>): Partial<JobWritableFields> {
  const diff: Partial<JobWritableFields> = {};
  for (const key of Object.keys(next) as Array<keyof JobWritableFields>) {
    if (JSON.stringify(next[key]) !== JSON.stringify(before[key])) (diff as Record<string, unknown>)[key] = next[key];
  }
  return diff;
}

function describe(cause: unknown): string {
  if (!(cause instanceof ApiError) && !(cause instanceof Error)) return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
  const e = cause as { code?: string; message: string; issues?: string[]; status?: number };
  if (e.code === 'MISSING_REQUIRED_JOB_FIELDS') return `ข้อมูลบังคับยังไม่ครบ: ${(e.issues ?? []).map((issue) => FIELD_LABEL[issue] ?? issue).join(', ')}`;
  if (e.code === 'COMPANY_NOT_VERIFIED') return 'บัญชีบริษัทยังไม่ผ่านการยืนยัน จึงสร้างประกาศไม่ได้';
  if (e.code === 'QUOTA_BELOW_COMMITTED') return 'จำนวนที่รับต่ำกว่าจำนวนที่จองหรือยืนยันไปแล้ว';
  return e.message;
}

export function HrJobForm() {
  const router = useRouter();
  const id = useSearchParams().get('id') ?? '';
  const { request } = useAuth();
  const api = useMemo(() => hrJobsApi(request), [request]);

  const [form, setForm] = useState<FormState>(EMPTY);
  const [loaded, setLoaded] = useState<HrJobDetail | null>(null);
  const [ready, setReady] = useState(!id);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [tagOptions, setTagOptions] = useState<JobTag[]>([]);

  useEffect(() => {
    let cancelled = false;
    api.tags().then((list) => { if (!cancelled) setTagOptions(list); }, () => undefined);
    return () => { cancelled = true; };
  }, [api]);

  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    api.get(id).then(
      (job) => { if (!cancelled) { setLoaded(job); setForm(fromJob(job)); setReady(true); } },
      (cause) => { if (!cancelled) setLoadError(cause instanceof ApiError && cause.status === 404 ? 'ไม่พบประกาศนี้ในบริษัทของคุณ' : describe(cause)); },
    );
    return () => { cancelled = true; };
  }, [api, id]);

  const status: JobStatus = loaded?.status ?? 'DRAFT';
  const editable = EDITABLE_STATUSES.includes(status);
  const lockedField = (name: string) => !editable || (status === 'CLOSED' && !CLOSED_FIELDS.includes(name));
  const set = (key: keyof FormState) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  const fields = toFields(form);
  const diff = loaded ? changedFields(fields, toFields(fromJob(loaded))) : fields;

  function validate(forSubmit: boolean): string | null {
    if (form.tagIds.length > TAG_MAX) return `เลือก Tag ทักษะได้ไม่เกิน ${TAG_MAX} รายการ`;
    if (form.hours.trim() && !(Number(form.hours) >= 1 && Number(form.hours) <= 168)) return 'ชั่วโมงต่อสัปดาห์ต้องอยู่ระหว่าง 1–168';
    if (form.quota.trim() && !(Number.isInteger(Number(form.quota)) && Number(form.quota) >= 1)) return 'จำนวนที่รับต้องเป็นจำนวนเต็มตั้งแต่ 1';
    if (form.allowanceType === 'AMOUNT' && form.allowanceAmount.trim() && !(Number(form.allowanceAmount) > 0)) return 'จำนวนเบี้ยเลี้ยงต้องมากกว่า 0';
    if ((form.periodStart && !form.periodEnd) || (!form.periodStart && form.periodEnd)) return 'กรุณาระบุช่วงเวลาฝึกงานทั้งวันเริ่มและวันสิ้นสุด';
    if (form.periodStart && form.periodEnd && form.periodEnd <= form.periodStart) return 'วันสิ้นสุดการฝึกต้องอยู่หลังวันเริ่ม';
    if (forSubmit) {
      const missing = missingRequired(fields as Record<string, unknown>);
      if (missing.length > 0) return `ยังกรอกไม่ครบก่อนเผยแพร่: ${missing.map((key) => FIELD_LABEL[key] ?? key).join(', ')}`;
    }
    return null;
  }

  /** บันทึก (สร้างหรือแก้) แล้วคืน id ของประกาศ */
  async function save(): Promise<string> {
    if (!id) {
      const created = await api.create(fields);
      return created.id;
    }
    if (Object.keys(diff).length > 0) await api.update(id, diff);
    return id;
  }

  async function run(forSubmit: boolean, event?: FormEvent) {
    event?.preventDefault();
    const problem = validate(forSubmit);
    if (problem) { setMessage({ tone: 'error', text: problem }); return; }
    setBusy(true);
    setMessage(null);
    try {
      const savedId = await save();
      if (forSubmit) {
        await api.submit(savedId);
        router.push(`/hr/jobs/item?id=${savedId}`);
        return;
      }
      if (!id) { router.replace(`/hr/jobs/form?id=${savedId}`); return; }
      const fresh = await api.get(savedId);
      setLoaded(fresh);
      setForm(fromJob(fresh));
      setMessage({ tone: 'success', text: 'บันทึกแล้ว' });
    } catch (cause) {
      setMessage({ tone: 'error', text: describe(cause) });
    } finally { setBusy(false); }
  }

  if (loadError) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">โหลดประกาศไม่สำเร็จ</h1>
        <p className="mt-2 text-sm text-ink-soft">{loadError}</p>
        <Link href="/hr/jobs" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปประกาศของฉัน</Link>
      </main>
    );
  }
  if (!ready) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const submittable = !loaded || ['DRAFT', 'ADMIN_REJECTED'].includes(status);
  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href={id ? `/hr/jobs/item?id=${id}` : '/hr/jobs'} className="text-sm font-medium text-primary hover:underline">กลับ</Link>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <h1 className="text-3xl font-semibold">{id ? 'แก้ไขประกาศ' : 'สร้างประกาศใหม่'}</h1>
        {loaded && <JobStatusBadge status={status} />}
      </div>
      {HR_JOBS_MOCK && <p className="mt-1 text-xs text-warning-text">ข้อมูลในหน้านี้เป็นข้อมูลจำลอง</p>}
      <p className="mt-2 text-sm text-ink-soft">บันทึกร่างได้แม้กรอกยังไม่ครบ ข้อมูลบังคับจะตรวจตอนเผยแพร่ ผู้สมัครติดต่อบริษัทผ่านแพลตฟอร์มเท่านั้น ห้ามใส่ช่องทางติดต่อส่วนตัวในประกาศ</p>

      {!editable && <div className="mt-4"><Notice tone="error">ประกาศในสถานะนี้แก้ไขไม่ได้</Notice></div>}
      {status === 'CLOSED' && <div className="mt-4"><Notice tone="success">ประกาศที่ปิดแล้วแก้ได้เฉพาะจำนวนที่รับ วันปิดรับสมัคร สาขา และช่วงเวลาฝึก</Notice></div>}

      <form onSubmit={(event) => void run(false, event)} noValidate className="mt-6 space-y-5">
        <label className="block text-sm font-medium">สายงาน
          <select value={form.category} onChange={set('category')} disabled={lockedField('category')} className={inputClass}>
            <option value="">เลือกสายงาน</option>
            {CATEGORIES.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}</option>)}
          </select>
        </label>
        <label className="block text-sm font-medium">ชื่อตำแหน่ง
          <input value={form.job_title} onChange={set('job_title')} disabled={lockedField('job_title')} className={inputClass} placeholder="เช่น Software Engineer Intern" />
        </label>
        <label className="block text-sm font-medium">รายละเอียดงาน
          <textarea value={form.description} onChange={set('description')} disabled={lockedField('description')} rows={4} className={inputClass} />
        </label>
        <label className="block text-sm font-medium">หน้าที่ความรับผิดชอบ
          <textarea value={form.responsibilities} onChange={set('responsibilities')} disabled={lockedField('responsibilities')} rows={4} className={inputClass} />
        </label>
        <label className="block text-sm font-medium">คุณสมบัติผู้สมัคร
          <textarea value={form.qualifications} onChange={set('qualifications')} disabled={lockedField('qualifications')} rows={3} className={inputClass} />
        </label>

        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block text-sm font-medium">สถานที่ฝึกงาน
            <input value={form.location} onChange={set('location')} disabled={lockedField('location')} className={inputClass} />
          </label>
          <label className="block text-sm font-medium">รูปแบบการทำงาน
            <select value={form.work_mode} onChange={set('work_mode')} disabled={lockedField('work_mode')} className={inputClass}>
              <option value="">เลือกรูปแบบ</option><option value="ONSITE">On-Site</option><option value="HYBRID">Hybrid</option><option value="REMOTE">Remote</option>
            </select>
          </label>
          <label className="block text-sm font-medium">ชั่วโมงต่อสัปดาห์
            <input type="number" min={1} max={168} value={form.hours} onChange={set('hours')} disabled={lockedField('hours_per_week')} className={inputClass} />
          </label>
          <label className="block text-sm font-medium">จำนวนที่รับ (ตำแหน่ง)
            <input type="number" min={1} value={form.quota} onChange={set('quota')} disabled={lockedField('quota')} className={inputClass} />
          </label>
        </div>

        <fieldset className="rounded-xl border border-border p-4">
          <legend className="px-1 text-sm font-medium">เบี้ยเลี้ยง</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block text-sm font-medium">ประเภท
              <select value={form.allowanceType} onChange={set('allowanceType')} disabled={lockedField('allowance')} className={inputClass}>
                <option value="">เลือก</option><option value="AMOUNT">มีเบี้ยเลี้ยง</option><option value="NONE">ไม่มีเบี้ยเลี้ยง</option>
              </select>
            </label>
            {form.allowanceType === 'AMOUNT' && (
              <>
                <label className="block text-sm font-medium">จำนวน (บาท)
                  <input type="number" min={1} value={form.allowanceAmount} onChange={set('allowanceAmount')} disabled={lockedField('allowance')} className={inputClass} />
                </label>
                <label className="block text-sm font-medium">ข้อความอธิบาย (ไม่บังคับ)
                  <input value={form.allowanceText} onChange={set('allowanceText')} disabled={lockedField('allowance')} className={inputClass} placeholder="เช่น 300 บาท/วัน" />
                </label>
              </>
            )}
          </div>
        </fieldset>

        <fieldset className="rounded-xl border border-border p-4">
          <legend className="px-1 text-sm font-medium">ช่วงเวลาและการรับสมัคร</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <label className="block text-sm font-medium">เริ่มฝึก
              <input type="date" value={form.periodStart} onChange={set('periodStart')} disabled={lockedField('period')} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">สิ้นสุดการฝึก
              <input type="date" value={form.periodEnd} onChange={set('periodEnd')} disabled={lockedField('period')} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">ปิดรับสมัคร
              <input type="date" value={form.deadline} onChange={set('deadline')} disabled={lockedField('application_deadline')} className={inputClass} />
            </label>
          </div>
        </fieldset>

        <label className="block text-sm font-medium">สาขาที่เปิดรับ
          <input value={form.majors} onChange={set('majors')} disabled={lockedField('target_majors')} className={inputClass} placeholder="คั่นด้วยเครื่องหมายจุลภาค เช่น วิทยาการคอมพิวเตอร์, สถิติ" />
          <span className="mt-1 block text-xs font-normal text-ink-soft">{parseMajors(form.majors).length} สาขา (อย่างน้อย 1 สาขาก่อนเผยแพร่)</span>
        </label>
        <fieldset className="rounded-xl border border-border p-4">
          <legend className="px-1 text-sm font-medium">Tag ทักษะ (1–{TAG_MAX} รายการ)</legend>
          {tagOptions.length === 0 && <p className="text-xs text-ink-soft">ยังไม่มี Tag ให้เลือก</p>}
          <div className="flex flex-wrap gap-2">
            {tagOptions.map((tag) => {
              const checked = form.tagIds.includes(tag.id);
              return (
                <label key={tag.id} className={`cursor-pointer rounded-full border px-3 py-1 text-sm ${checked ? 'border-primary bg-primary-soft text-primary' : 'border-border'} ${lockedField('tag_ids') ? 'opacity-60' : ''}`}>
                  <input type="checkbox" className="sr-only" checked={checked} disabled={lockedField('tag_ids')}
                    onChange={() => setForm((current) => ({ ...current, tagIds: checked ? current.tagIds.filter((tagId) => tagId !== tag.id) : [...current.tagIds, tag.id] }))} />
                  {tag.name}
                </label>
              );
            })}
          </div>
          <span className="mt-2 block text-xs text-ink-soft">เลือกแล้ว {form.tagIds.length} รายการ</span>
        </fieldset>
        <label className="block text-sm font-medium">หมายเหตุสำหรับทีมตรวจสอบ (ไม่บังคับ — ไม่แสดงต่อสาธารณะ)
          <textarea value={form.contact_notes} onChange={set('contact_notes')} disabled={lockedField('contact_notes')} rows={2} className={inputClass} />
        </label>

        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy || !editable} className="rounded-full border border-border px-6 py-2.5 font-semibold hover:bg-surface-muted disabled:cursor-not-allowed disabled:opacity-60">
            {busy ? 'กำลังบันทึก…' : 'บันทึก'}
          </button>
          {submittable && editable && (
            <button type="button" disabled={busy} onClick={() => void run(true)} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
              บันทึกและเผยแพร่
            </button>
          )}
        </div>
      </form>
    </main>
  );
}
