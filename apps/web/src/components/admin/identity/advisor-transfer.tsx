'use client';

import { useCallback, useEffect, useId, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import type { AdminUserListItem, Paginated } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { USER_STATUS_LABEL, labelOf } from '@/lib/status-map';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 100;


type Request = ReturnType<typeof useAuth>['request'];

/** ดึง /admin/users ทุกหน้า (page_size สูงสุด 100) — กันคนที่ตรงรหัสหลุดไปอยู่หน้าถัดไป */
async function fetchAllUsers(request: Request, filters: Record<string, string>): Promise<AdminUserListItem[]> {
  const rows: AdminUserListItem[] = [];
  for (let page = 1; ; page += 1) {
    const query = new URLSearchParams({ ...filters, page: String(page), page_size: String(PAGE_SIZE) });
    const result = await request<Paginated<AdminUserListItem>>(`/admin/users?${query}`);
    rows.push(...result.data);
    if (!result.data.length || page * result.meta.page_size >= result.meta.total) break;
  }
  return rows;
}

function failure(cause: unknown, fallback: string) {
  return cause instanceof Error ? cause.message : fallback;
}

/**
 * ย้ายนักศึกษาไปอาจารย์คนใหม่ด้วยรหัสนักศึกษา (POST /admin/students/{id}/advisor)
 * — ค้นจาก GET /admin/users แล้วเลือกเฉพาะ student_code ที่ตรงทุกตัวอักษร
 * — อาจารย์ปลายทางต้องอยู่มหาวิทยาลัยเดียวกันและใช้งานอยู่ (API ตรวจซ้ำ)
 */
export function AdvisorTransfer() {
  const { request } = useAuth();
  const params = useSearchParams();
  const formId = useId();
  const [code, setCode] = useState(params.get('code') ?? '');
  const [matches, setMatches] = useState<AdminUserListItem[] | null>(null);
  const [searchedCode, setSearchedCode] = useState('');
  const [studentId, setStudentId] = useState('');
  const [advisors, setAdvisors] = useState<AdminUserListItem[] | null>(null);
  const [targetId, setTargetId] = useState('');
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    fetchAllUsers(request, { role: 'ADVISOR', status: 'ACTIVE' })
      .then((rows) => { if (active) setAdvisors(rows); })
      .catch((cause) => { if (active) { setAdvisors([]); setError(failure(cause, 'โหลดรายชื่ออาจารย์ไม่สำเร็จ')); } });
    return () => { active = false; };
  }, [request]);

  const search = useCallback(async (raw: string, preferId?: string) => {
    const value = raw.trim();
    setError(''); setNotice(''); setTargetId(''); setStudentId('');
    if (!value) { setMatches(null); setError('กรุณากรอกรหัสนักศึกษา'); return; }
    setSearching(true);
    try {
      const rows = await fetchAllUsers(request, { role: 'STUDENT', q: value });
      setMatches(rows); setSearchedCode(value);
      const preferred = preferId ? rows.find((row) => row.id === preferId) : undefined;
      if (preferred) setStudentId(preferred.id);
      else if (rows.length === 1) setStudentId(rows[0].id);
    } catch (cause) { setMatches(null); setError(failure(cause, 'ค้นหานักศึกษาไม่สำเร็จ')); }
    finally { setSearching(false); }
  }, [request]);

  // มาจากปุ่ม "ย้ายอาจารย์" ในหน้าผู้ใช้: ?student=<รหัสบัญชี>&code=<รหัสนักศึกษา>
  // ค้นครั้งเดียว — request เปลี่ยน identity ได้เมื่อ token หมุน ห้ามล้างสิ่งที่ Admin เลือกไว้
  const presetDone = useRef(false);
  useEffect(() => {
    if (presetDone.current) return;
    presetDone.current = true;
    const presetCode = params.get('code')?.trim();
    const presetId = params.get('student')?.trim();
    if (presetCode) void search(presetCode, presetId && UUID.test(presetId) ? presetId : undefined);
  }, [params, search]);

  const student = matches?.find((row) => row.id === studentId) ?? null;
  const advisorLabel = (row: AdminUserListItem) => `${row.full_name} · ${row.email}`;
  const currentAdvisor = student?.advisor_id ? advisors?.find((row) => row.id === student.advisor_id) : undefined;
  const choices = student && advisors
    ? advisors.filter((row) => row.university_id !== null && row.university_id === student.university_id && row.id !== student.advisor_id)
    : [];
  const target = choices.find((row) => row.id === targetId);

  async function move(event: React.FormEvent) {
    event.preventDefault();
    if (!student || !target) { setError('กรุณาเลือกนักศึกษาและอาจารย์คนใหม่'); return; }
    if (!window.confirm(`ย้าย ${student.full_name} (${student.student_code || student.email}) ไปอยู่กับ ${advisorLabel(target)}?`)) return;
    setBusy(true); setError(''); setNotice('');
    try {
      await request(`/admin/students/${student.id}/advisor`, { method: 'POST', body: { advisor_id: target.id } });
      setNotice(`ย้าย ${student.full_name} ไปอยู่กับ ${target.full_name} แล้ว`);
      setMatches((rows) => rows?.map((row) => row.id === student.id ? { ...row, advisor_id: target.id } : row) ?? null);
      setTargetId('');
    } catch (cause) { setError(failure(cause, 'ย้ายอาจารย์ไม่สำเร็จ')); }
    finally { setBusy(false); }
  }

  return <section id="move-student" aria-labelledby={`${formId}-title`} className="rounded-xl border border-border bg-surface p-4">
    <h2 id={`${formId}-title`} className="text-lg font-semibold">ย้ายอาจารย์ของนักศึกษา</h2>
    <p className="mt-1 text-sm text-ink-soft">ค้นด้วยรหัสนักศึกษา ระบบย้ายได้เฉพาะไปยังอาจารย์ที่ใช้งานอยู่ในมหาวิทยาลัยเดียวกัน</p>
    {(error || notice) && <div className="mt-3">{error ? <Notice tone="error">{error}</Notice> : <Notice tone="success">{notice}</Notice>}</div>}

    <form role="search" onSubmit={(event) => { event.preventDefault(); void search(code); }} className="mt-4 flex flex-wrap items-end gap-3">
      <label className="min-w-64 flex-1 text-sm">ชื่อ อีเมล หรือรหัสนักศึกษา
        <input value={code} onChange={(event) => setCode(event.target.value)} maxLength={100} autoComplete="off"
          className="mt-1 w-full rounded-lg border border-border px-3 py-2 text-sm" /></label>
      <button disabled={searching} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{searching ? 'กำลังค้นหา…' : 'ค้นหา'}</button>
    </form>

    {matches && !matches.length && <p role="status" className="mt-4 text-sm text-ink-soft">ไม่ผลการค้นหา {searchedCode}</p>}

    {matches && matches.length > 1 && <fieldset className="mt-4">
      <legend className="text-sm font-medium">ผลการค้นหา {searchedCode} {matches.length} คน — เลือกคนที่ต้องการย้าย</legend>
      <div className="mt-2 divide-y divide-border rounded-lg border border-border">
        {matches.map((row) => <label key={row.id} className="flex cursor-pointer items-start gap-3 p-3 text-sm has-[:checked]:bg-surface-muted">
          <input type="radio" name={`${formId}-student`} value={row.id} checked={studentId === row.id}
            onChange={() => { setStudentId(row.id); setTargetId(''); setNotice(''); }} className="mt-1" />
          <span className="min-w-0"><span className="block font-medium">{row.full_name}</span>
            <span className="block break-all text-ink-soft">{row.email} · {labelOf(USER_STATUS_LABEL, row.status)}</span></span>
        </label>)}
      </div>
    </fieldset>}

    {student && <form onSubmit={(event) => void move(event)} className="mt-4 space-y-4">
      <dl className="divide-y divide-border rounded-lg bg-surface-muted px-4 text-sm">
        {([
          ['นักศึกษา', student.full_name],
          ['อีเมล', student.email],
          ['สถานะบัญชี', labelOf(USER_STATUS_LABEL, student.status)],
          ['อาจารย์คนปัจจุบัน', !student.advisor_id ? 'ยังไม่มีอาจารย์ที่ปรึกษา'
            : currentAdvisor ? advisorLabel(currentAdvisor)
            : advisors ? 'อาจารย์ที่ไม่ได้อยู่ในสถานะใช้งาน' : 'กำลังโหลด…'],
        ] as Array<[string, string]>).map(([label, value]) => <div key={label} className="flex flex-wrap justify-between gap-x-4 gap-y-1 py-2">
          <dt className="text-ink-soft">{label}</dt><dd className="break-all font-medium">{value}</dd></div>)}
      </dl>
      {!advisors ? <p className="text-sm text-ink-soft">กำลังโหลดรายชื่ออาจารย์…</p>
        : !choices.length ? <p role="status" className="text-sm text-ink-soft">ไม่มีอาจารย์ที่ใช้งานอยู่ในมหาวิทยาลัยเดียวกันให้เลือก</p>
        : <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-64 flex-1 text-sm">อาจารย์คนใหม่
            <select value={targetId} onChange={(event) => setTargetId(event.target.value)} required
              className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm">
              <option value="">เลือกอาจารย์</option>
              {choices.map((row) => <option key={row.id} value={row.id}>{advisorLabel(row)}</option>)}
            </select></label>
          <button disabled={busy || !target} className="rounded-lg bg-primary px-4 py-2 text-sm font-medium text-white disabled:opacity-50">
            {busy ? 'กำลังย้าย…' : 'ยืนยันย้ายนักศึกษา'}</button>
        </div>}
    </form>}
  </section>;
}
