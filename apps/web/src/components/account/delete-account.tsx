'use client';

import Link from 'next/link';
import type { UserMeResponse } from '@internpath/contracts';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

const CONFIRM_WORD = 'ลบบัญชี';

function describe(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ลบบัญชีไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'DELETION_BLOCKED' && cause.issues.includes('ACTIVE_APPLICATION')) return 'ยังมีใบสมัครที่ดำเนินอยู่ กรุณาตรวจสอบใบสมัครก่อนลบบัญชี';
  if (cause.status === 401) return 'เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่';
  if (cause.code === 'DELETION_BLOCKED') {
    return 'ลบบัญชีไม่ได้ในขณะนี้ เพราะมีใบสมัครที่ยังดำเนินอยู่ (รออาจารย์อนุมัติ กำลังฝึกงาน หรืออยู่ระหว่างโต้แย้ง/ประเมินซ้ำ) หรือคุณเป็นเจ้าของบัญชีบริษัท (Owner) ที่ยังไม่ได้โอนสิทธิ์ กรุณาจัดการให้เรียบร้อยก่อน';
  }
  if (cause.code === 'UPSTREAM_UNAVAILABLE') return 'ยังยืนยันผลการลบบัญชีไม่ได้ กรุณาตรวจสถานะบัญชีอีกครั้งเมื่อเชื่อมต่อได้';
  if (cause.status === 404) return 'ไม่พบบัญชีนี้ในระบบ กรุณาเข้าสู่ระบบใหม่อีกครั้ง';
  return cause.message;
}

/**
 * ขอลบบัญชี — `POST /users/me/deletion-request` (ซิงโครนัส: สำเร็จ ⇒ 204 และ token ถูกเพิกถอนทันที)
 * สิ่งที่ลบ/เก็บตาม README 5.11 และ data-schema §2.3 — หน้านี้เป็นการยืนยันที่ย้อนกลับไม่ได้ จึงให้พิมพ์คำยืนยันก่อน
 */
export function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const { request, logout, user } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [companyRole, setCompanyRole] = useState<string | null>(null);
  const student = user?.role === 'STUDENT';
  useEffect(() => {
    if (user?.role !== 'COMPANY_HR') return;
    let active = true;
    request<UserMeResponse>('/users/me').then((me) => {
      if (active) setCompanyRole(me.company?.member_role ?? null);
    }, () => {});
    return () => { active = false; };
  }, [request, user?.role]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() !== CONFIRM_WORD) { setError(`พิมพ์ "${CONFIRM_WORD}" ให้ตรงเพื่อยืนยัน`); return; }
    setBusy(true);
    setError(null);
    try {
      await request<void>('/users/me/deletion-request', { method: 'POST' });
      onDeleted();
      try { await logout(); } catch { /* token ถูกเพิกถอนแล้ว — session ในเครื่องถูกล้างเสมอ */ }
    } catch (cause) { setError(describe(cause)); }
    finally { setBusy(false); }
  }


  return (
    <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6">
      <Link href="/account" className="text-sm font-medium text-primary hover:underline">บัญชีของฉัน</Link>
      <h1 className="mt-3 text-3xl font-semibold">ลบบัญชี</h1>
      <p className="mt-2 text-sm text-ink-soft">การลบบัญชีทำย้อนกลับไม่ได้ ทุกอุปกรณ์จะถูกออกจากระบบทันที</p>

      <p className="mt-4 font-medium [overflow-wrap:anywhere]">{user?.full_name} · {user?.email}</p>
      <div className="mt-6 grid gap-4 sm:grid-cols-2">
        <section aria-labelledby="deleted-title" className="rounded-xl border border-border p-4">
          <h2 id="deleted-title" className="text-lg font-semibold">สิ่งที่จะถูกลบ</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {user?.role === 'ADVISOR' && <li>ความเชื่อมโยงกับนักศึกษาในความดูแล</li>}
            {user?.role === 'COMPANY_HR' && <li>สิทธิ์ของคุณในทีม HR ของบริษัท</li>}
            <li>{student ? 'ข้อมูลส่วนตัว โปรไฟล์ รูปโปรไฟล์ เรซูเม่ และไฟล์ใบรับรองที่มีชื่อจริง' : 'ข้อมูลส่วนตัวและข้อมูลเข้าสู่ระบบ'}</li>
            {student && <li>ใบสมัครที่ยังไม่ถึงขั้นรออาจารย์อนุมัติจะถูกยกเลิก และโควตาที่จองไว้จะถูกคืน</li>}
            {student && <li>รีวิวที่ยังรอตรวจหรือถูกพักไว้ จะถูกลบพร้อมเนื้อหา</li>}
          </ul>
        </section>
        <section aria-labelledby="kept-title" className="rounded-xl border border-border p-4">
          <h2 id="kept-title" className="text-lg font-semibold">สิ่งที่ยังเก็บไว้ (โดยไม่ระบุตัวตน)</h2>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
            {student && <li>E-Certificate ที่ออกแล้วยังตรวจสอบได้ แต่ชื่อบนหน้าตรวจสอบจะแสดงเป็น "ผู้ใช้ที่ลบบัญชีแล้ว"</li>}
            {student && <li>รีวิวที่เผยแพร่แล้วยังอยู่ แต่ไม่ระบุตัวตน และไม่กระทบคะแนนของบริษัท</li>}
            <li>ประวัติการเปลี่ยนสถานะและบันทึกตรวจสอบ ซึ่งแทนตัวตนด้วยรหัสนิรนาม</li>
          </ul>
        </section>
      </div>

      {(student || (user?.role === 'COMPANY_HR' && companyRole === 'OWNER')) && <section aria-labelledby="blocked-title" className="mt-4 rounded-xl border border-border bg-warning-soft p-4">
        <h2 id="blocked-title" className="text-lg font-semibold text-warning-text">ลบไม่ได้เมื่อ</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-warning-text">
          {student && <li>
            มีใบสมัครที่ยังดำเนินอยู่ (รออาจารย์อนุมัติ อนุมัติแล้ว กำลังฝึกงาน หรืออยู่ระหว่างโต้แย้ง/ประเมินซ้ำ)
            {user?.role === 'STUDENT' && <> <Link href="/student/applications" className="font-medium text-primary hover:underline">ดูใบสมัครของฉัน ›</Link></>}
          </li>}
          {!student && <li>คุณเป็นเจ้าของบัญชีบริษัท (Owner) ที่ยังไม่ได้โอนสิทธิ์ให้สมาชิกคนอื่น <Link className="underline" href="/hr/team">จัดการทีม HR</Link></li>}
        </ul>
      </section>}
      <Link href="/privacy#retention" className="mt-4 inline-block text-sm text-primary">นโยบายการเก็บรักษาข้อมูล</Link>

      <form onSubmit={(event) => void submit(event)} noValidate className="mt-6 space-y-4">
        <div>
          <label htmlFor="delete-confirm" className="block text-sm font-medium">พิมพ์ &quot;{CONFIRM_WORD}&quot; เพื่อยืนยัน</label>
          <input id="delete-confirm" value={text} onChange={(event) => setText(event.target.value)} autoComplete="off"
            aria-invalid={error ? true : undefined}
            className="mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-danger-text focus:ring-2 focus:ring-danger-soft" />
        </div>
        {error && <Notice tone="error">{error}</Notice>}
        <div className="flex flex-wrap gap-3">
          <button type="submit" disabled={busy || text.trim() !== CONFIRM_WORD} className="rounded-full bg-danger-text px-6 py-2.5 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50">
            {busy ? 'กำลังลบบัญชี…' : 'ลบบัญชีถาวร'}
          </button>
          <Link href="/account" className="rounded-full border border-border px-6 py-2.5 font-semibold hover:bg-surface-muted">ยกเลิก</Link>
        </div>
      </form>
    </main>
  );
}
