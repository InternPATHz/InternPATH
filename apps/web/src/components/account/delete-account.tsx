'use client';

import Link from 'next/link';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

const CONFIRM_WORD = 'ลบบัญชี';

function describe(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'ลบบัญชีไม่สำเร็จ กรุณาลองใหม่';
  if (cause.code === 'DELETION_BLOCKED') {
    return 'ลบบัญชีไม่ได้ในขณะนี้ เพราะมีใบสมัครที่ยังดำเนินอยู่ (รออาจารย์อนุมัติ กำลังฝึกงาน หรืออยู่ระหว่างโต้แย้ง/ประเมินซ้ำ) หรือคุณเป็นเจ้าของบัญชีบริษัท (Owner) ที่ยังไม่ได้โอนสิทธิ์ กรุณาจัดการให้เรียบร้อยก่อน';
  }
  if (cause.code === 'UPSTREAM_UNAVAILABLE') return 'ตรวจสถานะใบสมัครไม่ได้ในขณะนี้ ระบบจึงยังไม่ลบบัญชีเพื่อความปลอดภัย กรุณาลองใหม่ภายหลัง';
  if (cause.status === 404) return 'ไม่พบบัญชีนี้ในระบบ กรุณาเข้าสู่ระบบใหม่อีกครั้ง';
  return cause.message;
}

/**
 * ขอลบบัญชี — `POST /users/me/deletion-request` (ซิงโครนัส: สำเร็จ ⇒ 204 และ token ถูกเพิกถอนทันที)
 * สิ่งที่ลบ/เก็บตาม README 5.11 และ data-schema §2.3 — หน้านี้เป็นการยืนยันที่ย้อนกลับไม่ได้ จึงให้พิมพ์คำยืนยันก่อน
 */
export function DeleteAccount() {
  const { request, logout } = useAuth();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (text.trim() !== CONFIRM_WORD) { setError(`พิมพ์ "${CONFIRM_WORD}" ให้ตรงเพื่อยืนยัน`); return; }
    setBusy(true);
    setError(null);
    try {
      await request<void>('/users/me/deletion-request', { method: 'POST' });
      setDone(true);
      try { await logout(); } catch { /* token ถูกเพิกถอนแล้ว — session ในเครื่องถูกล้างเสมอ */ }
    } catch (cause) { setError(describe(cause)); }
    finally { setBusy(false); }
  }

  if (done) {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-2xl font-semibold">ลบบัญชีเรียบร้อยแล้ว</h1>
        <p className="mt-3 text-sm text-ink-soft">ข้อมูลส่วนบุคคลของคุณถูกลบหรือทำให้ไม่ระบุตัวตนตามนโยบายความเป็นส่วนตัวแล้ว ขอบคุณที่ใช้ InternPath</p>
        <Link href="/" className="mt-6 inline-block text-sm font-medium text-primary hover:underline">กลับหน้าแรก</Link>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-2xl px-4 py-10 sm:px-6">
      <Link href="/account" className="text-sm font-medium text-primary hover:underline">บัญชีของฉัน</Link>
      <h1 className="mt-3 text-3xl font-semibold">ลบบัญชี</h1>
      <p className="mt-2 text-sm text-ink-soft">การลบบัญชีทำย้อนกลับไม่ได้ ทุกอุปกรณ์จะถูกออกจากระบบทันที</p>

      <section aria-labelledby="deleted-title" className="mt-6 rounded-xl border border-border p-4">
        <h2 id="deleted-title" className="text-lg font-semibold">สิ่งที่จะถูกลบ</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
          <li>ข้อมูลส่วนตัว โปรไฟล์ รูปโปรไฟล์ และเรซูเม่ที่อัปโหลดไว้</li>
          <li>ใบสมัครที่ยังไม่ถึงขั้นรออาจารย์อนุมัติจะถูกยกเลิก และโควตาที่จองไว้จะถูกคืน</li>
          <li>รีวิวที่ยังรอตรวจหรือถูกพักไว้ จะถูกลบพร้อมเนื้อหา</li>
        </ul>
      </section>
      <section aria-labelledby="kept-title" className="mt-4 rounded-xl border border-border p-4">
        <h2 id="kept-title" className="text-lg font-semibold">สิ่งที่ยังเก็บไว้ (โดยไม่ระบุตัวตน)</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
          <li>E-Certificate ที่ออกแล้วยังตรวจสอบได้ แต่ชื่อบนหน้าตรวจสอบจะแสดงเป็น "ผู้ใช้ที่ลบบัญชีแล้ว"</li>
          <li>รีวิวที่เผยแพร่แล้วยังอยู่ แต่ไม่ระบุตัวตน และไม่กระทบคะแนนของบริษัท</li>
          <li>ประวัติการเปลี่ยนสถานะและบันทึกตรวจสอบ ซึ่งแทนตัวตนด้วยรหัสนิรนาม</li>
        </ul>
      </section>
      <section aria-labelledby="blocked-title" className="mt-4 rounded-xl border border-border bg-warning-soft p-4">
        <h2 id="blocked-title" className="text-lg font-semibold text-warning-text">ลบไม่ได้เมื่อ</h2>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-warning-text">
          <li>มีใบสมัครที่ยังดำเนินอยู่ (รออาจารย์อนุมัติ อนุมัติแล้ว กำลังฝึกงาน หรืออยู่ระหว่างโต้แย้ง/ประเมินซ้ำ)</li>
          <li>คุณเป็นเจ้าของบัญชีบริษัท (Owner) ที่ยังไม่ได้โอนสิทธิ์ให้สมาชิกคนอื่น</li>
        </ul>
      </section>

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
