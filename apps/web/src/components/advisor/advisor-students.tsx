'use client';

import Link from 'next/link';

import { useCallback, useEffect, useId, useState } from 'react';
import type { FormEvent } from 'react';
import type {
  AdvisorStudentItem, AdvisorTrainingStudentItem, CreateStudentRequest, CreateStudentResponse, Paginated,
} from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect, Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

const PAGE_SIZE = 20;
const dateTime = new Intl.DateTimeFormat('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });

const TRAINING_LABEL = { IN_TRAINING: 'กำลังฝึกงาน', COMPLETED: 'ฝึกงานเสร็จแล้ว', NONE: 'ยังไม่ได้ฝึกงาน' } as const;
const TRAINING_STYLE = {
  IN_TRAINING: 'bg-info-soft text-info-text', COMPLETED: 'bg-success-soft text-success-text', NONE: 'bg-surface-muted text-ink-soft',
} as const;

const YEAR_OPTIONS: Array<[string, string]> = [['', 'ทุกชั้นปี'], ...[1, 2, 3, 4, 5, 6].map((year): [string, string] => [String(year), `ชั้นปี ${year}`])];

function failure(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
  const issue = cause.issues?.[0];
  if (issue === 'EMAIL_DOMAIN_NOT_ALLOWED') return 'อีเมลนักศึกษาต้องเป็นโดเมนสถาบันเดียวกับอาจารย์ (.ac.th)';
  if (issue === 'EMAIL_ALREADY_REGISTERED') return 'อีเมลนี้ลงทะเบียนในระบบแล้ว';
  if (issue === 'STUDENT_CODE_ALREADY_USED') return 'รหัสนักศึกษานี้ถูกใช้แล้วในสถาบันเดียวกัน';
  if (cause.code === 'MAIL_UNAVAILABLE') return 'ส่งอีเมลคำเชิญไม่สำเร็จ ลองอีกครั้งภายหลัง';
  return cause.message;
}

const EMPTY_FORM = { email: '', full_name: '', student_code: '', major: '', year_level: '' };
const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

/**
 * หน้านักศึกษาของอาจารย์ (ปรับ Requirement 2026-11-21: นักศึกษาไม่สมัครเอง — อาจารย์เพิ่มและดูแลนักศึกษา)
 * - ฟอร์มเพิ่มนักศึกษา → Identity `POST /advisor-links/students` (ส่งอีเมลคำเชิญ 7 วัน)
 * - รายชื่อพร้อมตัวกรองชั้นปี/กำลังฝึกงาน/ฝึกงานเสร็จแล้ว → Lifecycle `GET /advisor/students`
 * - บัญชีที่ยังไม่ตั้งรหัสผ่าน → Identity `GET /advisor-links/students?activation=PENDING` (ส่งคำเชิญซ้ำ/ยกเลิก)
 */
/** label อยู่ข้างช่อง (ไม่ครอบ) เพื่อให้ชื่อช่องที่เครื่องอ่านหน้าจออ่านไม่พ่วงค่าที่พิมพ์อยู่ */
function Field({ id, label, className = '', children }: { id: string; label: string; className?: string; children: React.ReactNode }) {
  return (
    <div className={className}>
      <label htmlFor={id} className="text-sm font-medium">{label}</label>
      {children}
    </div>
  );
}

export function AdvisorStudents() {
  const fieldId = useId();
  const { request } = useAuth();
  const [form, setForm] = useState(EMPTY_FORM);
  const [formBusy, setFormBusy] = useState(false);
  const [formMessage, setFormMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [reload, setReload] = useState(0);

  const [q, setQ] = useState('');
  const [yearLevel, setYearLevel] = useState('');
  const [training, setTraining] = useState('');
  const [page, setPage] = useState(1);
  const [list, setList] = useState<Paginated<AdvisorTrainingStudentItem> | null>(null);
  const [listError, setListError] = useState('');
  const [loading, setLoading] = useState(true);

  const [pending, setPending] = useState<AdvisorStudentItem[]>([]);
  const [pendingMessage, setPendingMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setListError('');
    const query = new URLSearchParams({ page: String(page), page_size: String(PAGE_SIZE) });
    if (q.trim()) query.set('q', q.trim());
    if (yearLevel) query.set('year_level', yearLevel);
    if (training) query.set('training_status', training);
    request<Paginated<AdvisorTrainingStudentItem>>(`/advisor/students?${query.toString()}`)
      .then((data) => { if (active) setList(data); })
      .catch((cause) => { if (active) { setList(null); setListError(failure(cause)); } })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [q, yearLevel, training, page, reload, request]);

  useEffect(() => {
    let active = true;
    request<Paginated<AdvisorStudentItem>>('/advisor-links/students?activation=PENDING&page_size=100')
      .then((data) => { if (active) setPending(data.data); })
      .catch(() => { if (active) setPending([]); });
    return () => { active = false; };
  }, [reload, request]);

  const set = (key: keyof typeof EMPTY_FORM) => (event: { target: { value: string } }) => setForm((current) => ({ ...current, [key]: event.target.value }));

  async function create(event: FormEvent) {
    event.preventDefault();
    const year = Number(form.year_level);
    if (!Number.isInteger(year) || year < 1 || year > 10) { setFormMessage({ tone: 'error', text: 'ชั้นปีต้องเป็นจำนวนเต็ม 1–10' }); return; }
    setFormBusy(true);
    setFormMessage(null);
    try {
      const body: CreateStudentRequest = {
        email: form.email.trim(), full_name: form.full_name.trim(), student_code: form.student_code.trim(), major: form.major.trim(), year_level: year,
      };
      const created = await request<CreateStudentResponse>('/advisor-links/students', { method: 'POST', body });
      setForm(EMPTY_FORM);
      setFormMessage({ tone: 'success', text: `เพิ่มนักศึกษาแล้ว ส่งคำเชิญไปที่ ${created.email} (ลิงก์ใช้ได้ถึง ${dateTime.format(new Date(created.invitation_expires_at))})` });
      setReload((key) => key + 1);
    } catch (cause) { setFormMessage({ tone: 'error', text: failure(cause) }); }
    finally { setFormBusy(false); }
  }

  const act = useCallback(async (student: AdvisorStudentItem, kind: 'resend' | 'cancel') => {
    if (kind === 'cancel' && !window.confirm(`ยกเลิกบัญชีของ ${student.full_name}? (ใช้ได้เฉพาะคนที่ยังไม่ตั้งรหัสผ่าน)`)) return;
    setBusyId(student.user_id);
    setPendingMessage(null);
    try {
      if (kind === 'resend') {
        await request(`/advisor-links/students/${encodeURIComponent(student.user_id)}/actions/resend-invitation`, { method: 'POST' });
        setPendingMessage({ tone: 'success', text: `ส่งคำเชิญใหม่ไปที่ ${student.email} แล้ว (ลิงก์เดิมใช้ไม่ได้)` });
      } else {
        await request(`/advisor-links/students/${encodeURIComponent(student.user_id)}/invitation`, { method: 'DELETE' });
        setPendingMessage({ tone: 'success', text: `ยกเลิกบัญชีของ ${student.full_name} แล้ว` });
      }
      setReload((key) => key + 1);
    } catch (cause) { setPendingMessage({ tone: 'error', text: failure(cause) }); }
    finally { setBusyId(null); }
  }, [request]);

  const total = list?.meta.total ?? 0;
  const lastPage = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">นักศึกษาในความดูแล</h1>
      <p className="mt-2 text-sm text-ink-soft">
        นักศึกษาไม่ต้องสมัครสมาชิกเอง อาจารย์เพิ่มนักศึกษาที่นี่ นักศึกษาจะได้อีเมลลิงก์เพื่อตั้งรหัสผ่าน แล้วสมัครฝึกงานด้วยตนเองได้ตามปกติ
      </p>

      {pending.length > 0 && (
        <section aria-labelledby="pending-title" className="mt-8">
          <h2 id="pending-title" className="text-lg font-semibold">รอตั้งรหัสผ่าน ({pending.length})</h2>
          {pendingMessage && <div className="mt-3"><Notice tone={pendingMessage.tone}>{pendingMessage.text}</Notice></div>}
          <ul className="mt-3 divide-y divide-border rounded-xl border border-border">
            {pending.map((student) => (
              <li key={student.user_id} className="flex flex-wrap items-center gap-3 p-4 text-sm">
                <div className="min-w-0 flex-1">
                  <p className="font-medium">{student.full_name} <span className="text-xs text-ink-soft">({student.student_code})</span></p>
                  <p className="truncate text-xs text-ink-soft">
                    {student.email}{student.invitation_expires_at && ` · ลิงก์หมดอายุ ${dateTime.format(new Date(student.invitation_expires_at))}`}
                  </p>
                </div>
                <button type="button" disabled={busyId === student.user_id} onClick={() => void act(student, 'resend')}
                  className="font-medium text-primary hover:underline disabled:opacity-60">ส่งคำเชิญอีกครั้ง</button>
                <button type="button" disabled={busyId === student.user_id} onClick={() => void act(student, 'cancel')}
                  className="font-medium text-danger-text hover:underline disabled:opacity-60">ยกเลิกบัญชี</button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <details className="mt-6 rounded-xl border border-border bg-surface p-5">
        <summary className="cursor-pointer text-lg font-semibold text-primary">เพิ่มนักศึกษา</summary>
        <form onSubmit={(event) => void create(event)} className="mt-4 grid gap-4 sm:grid-cols-2">
          <Field id={`${fieldId}-email`} label="อีเมลสถาบัน (.ac.th ของสถาบันเดียวกับอาจารย์)" className="sm:col-span-2">
            <input id={`${fieldId}-email`} type="email" inputMode="email" required value={form.email} onChange={set('email')} className={inputClass}
              autoComplete="off" aria-describedby={formMessage ? `${fieldId}-message` : undefined} />
          </Field>
          <Field id={`${fieldId}-name`} label="ชื่อ-นามสกุล">
            <input id={`${fieldId}-name`} required value={form.full_name} onChange={set('full_name')} maxLength={200} className={inputClass} autoComplete="off" />
          </Field>
          <Field id={`${fieldId}-code`} label="รหัสนักศึกษา">
            <input id={`${fieldId}-code`} required value={form.student_code} onChange={set('student_code')} maxLength={50} className={inputClass} autoComplete="off" />
          </Field>
          <Field id={`${fieldId}-major`} label="สาขาวิชา">
            <input id={`${fieldId}-major`} required value={form.major} onChange={set('major')} maxLength={200} className={inputClass} />
          </Field>
          <Field id={`${fieldId}-year`} label="ชั้นปี">
            <input id={`${fieldId}-year`} type="number" inputMode="numeric" required min={1} max={10} value={form.year_level} onChange={set('year_level')} className={inputClass} />
          </Field>
          <div className="sm:col-span-2">
            {formMessage && <div id={`${fieldId}-message`} className="mb-3"><Notice tone={formMessage.tone}>{formMessage.text}</Notice></div>}
            <button type="submit" disabled={formBusy} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">
              {formBusy ? 'กำลังเพิ่ม…' : 'เพิ่มนักศึกษาและส่งคำเชิญ'}
            </button>
          </div>
        </form>
      </details>

      <section aria-labelledby="list-title" className="mt-8">
        <h2 id="list-title" className="text-lg font-semibold">รายชื่อนักศึกษา</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3 rounded-xl border border-border bg-surface p-4">
          <div className="text-sm">
            <label htmlFor={`${fieldId}-q`} className="mb-1 block text-xs font-medium text-ink-soft">ค้นหา (ชื่อ รหัส สาขา)</label>
            <input id={`${fieldId}-q`} type="search" value={q} onChange={(event) => { setQ(event.target.value); setPage(1); }}
              className="rounded-lg border border-border px-3 py-2 text-sm outline-none focus:border-primary" />
          </div>
          <FilterSelect label="ชั้นปี" value={yearLevel} onChange={(value) => { setYearLevel(value); setPage(1); }} options={YEAR_OPTIONS} />
          <FilterSelect label="สถานะการฝึกงาน" value={training} onChange={(value) => { setTraining(value); setPage(1); }}
            options={[['', 'ทั้งหมด'], ['IN_TRAINING', 'กำลังฝึกงาน'], ['COMPLETED', 'ฝึกงานเสร็จแล้ว']]} />
        </div>

        {listError && <div className="mt-4"><Notice tone="error">{listError}</Notice></div>}

        <div className="mt-4 overflow-x-auto rounded-xl border border-border bg-surface">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-border bg-surface-muted text-xs text-ink-soft">
              <tr>
                <th scope="col" className="px-4 py-3 font-medium">นักศึกษา</th>
                <th scope="col" className="px-4 py-3 font-medium">สาขา</th>
                <th scope="col" className="px-4 py-3 font-medium">ชั้นปี</th>
                <th scope="col" className="px-4 py-3 font-medium">สถานะการฝึกงาน</th>
                <th scope="col" className="px-4 py-3 font-medium">ใบสมัครที่ดำเนินอยู่</th>
              </tr>
            </thead>
            <tbody>
              {loading && !list && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">กำลังโหลด…</td></tr>}
              {!loading && !listError && list && list.data.length === 0 && <tr><td colSpan={5} className="px-4 py-8 text-center text-ink-soft">ไม่มีนักศึกษาตามตัวกรองนี้</td></tr>}
              {list?.data.map((student) => (
                <tr key={student.student_user_id} className="border-t border-border">
                  <td className="px-4 py-3"><Link href={`/advisor/students/item?id=${student.student_user_id}`} className="font-medium text-primary hover:underline">{student.full_name}</Link><p className="text-xs text-ink-soft">{student.student_code}</p></td>
                  <td className="px-4 py-3">{student.major}</td>
                  <td className="px-4 py-3">{student.year_level}</td>
                  <td className="px-4 py-3">
                    <span className={`inline-block whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${TRAINING_STYLE[student.training_status]}`}>{TRAINING_LABEL[student.training_status]}</span>
                  </td>
                  <td className="px-4 py-3">{student.active_application_count}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {list && total > 0 && (
          <div className="mt-4 flex items-center justify-between text-sm text-ink-soft">
            <span>ทั้งหมด {total} คน · หน้า {page} จาก {lastPage}</span>
            <span className="flex gap-2">
              <button type="button" disabled={page <= 1} onClick={() => setPage((current) => current - 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-muted disabled:opacity-50">ก่อนหน้า</button>
              <button type="button" disabled={page >= lastPage} onClick={() => setPage((current) => current + 1)} className="rounded-lg border border-border px-3 py-1.5 hover:bg-surface-muted disabled:opacity-50">ถัดไป</button>
            </span>
          </div>
        )}
      </section>
    </main>
  );
}
