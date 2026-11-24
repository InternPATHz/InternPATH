'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { Paginated, ResumeItem } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

// ตาม api-contract §7.1: PDF ≤ 5 MB และมีได้ไม่เกิน 5 ไฟล์ (Lifecycle ตรวจ MIME จริงและตรวจซ้ำใต้ล็อก)
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 5;

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });

function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function failure(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 404) return 'ไม่พบไฟล์นี้แล้ว อาจถูกลบไปก่อนหน้า';
    return cause.message;
  }
  return 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่';
}

export function ResumeManager({ onCountChange }: { onCountChange: (count: number | null) => void }) {
  const { request } = useAuth();
  const input = useRef<HTMLInputElement>(null);
  const [resumes, setResumes] = useState<ResumeItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = useCallback(async () => {
    // รายการห่อด้วย { data, meta } (api-contract §1) — มีได้ไม่เกิน 5 ไฟล์ จึงอยู่ในหน้าเดียวเสมอ
    try {
      const result = await request<Paginated<ResumeItem>>('/me/resumes');
      setResumes(result.data);
      onCountChange(result.data.length);
    } catch (cause) {
      onCountChange(null);
      setResumes([]);
      setMessage({ tone: 'error', text: failure(cause) });
    }
  }, [request, onCountChange]);

  useEffect(() => { void load(); }, [load]);

  function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    void upload(file);
  }

  async function upload(file: File | undefined) {
    if (!file || busy || full) return;
    if (file.type !== 'application/pdf' && !file.name.toLowerCase().endsWith('.pdf')) {
      setMessage({ tone: 'error', text: 'อัปโหลดได้เฉพาะไฟล์ PDF' });
      return;
    }
    if (file.size > MAX_BYTES) { setMessage({ tone: 'error', text: 'ไฟล์ต้องมีขนาดไม่เกิน 5 MB' }); return; }
    setBusy(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append('file', file);
      await request<ResumeItem>('/me/resumes', { method: 'POST', body: form });
      await load();
      setMessage({ tone: 'success', text: 'อัปโหลดเรซูเม่แล้ว' });
    } catch (cause) {
      // ครบ 5 ไฟล์ปิดปุ่มอัปโหลดไว้แล้ว; ถ้าเซิร์ฟเวอร์ปฏิเสธ (เช่น อัปโหลดพร้อมกันสองแท็บ) แสดงข้อความของเซิร์ฟเวอร์
      setMessage({ tone: 'error', text: failure(cause) });
    } finally { setBusy(false); }
  }

  async function remove(resume: ResumeItem) {
    if (busy) return;
    setConfirmId(null);
    setBusy(true);
    setMessage(null);
    try {
      await request<void>(`/me/resumes/${resume.id}`, { method: 'DELETE' });
      await load();
      setMessage({ tone: 'success', text: 'ลบเรซูเม่แล้ว' });
    } catch (cause) { setMessage({ tone: 'error', text: failure(cause) }); }
    finally { setBusy(false); }
  }

  const full = (resumes?.length ?? 0) >= MAX_FILES;
  return (
    <section aria-labelledby="resume-title" className="mt-10">
      <h2 id="resume-title" className="text-xl font-semibold">เรซูเม่</h2>
      <p className="mt-1 text-sm text-ink-soft">ไฟล์ PDF ไม่เกิน 5 MB มีได้สูงสุด {MAX_FILES} ไฟล์ ไฟล์แรกที่อัปโหลดเป็นไฟล์หลักโดยอัตโนมัติ บริษัทจะเห็นเรซูเม่เมื่อคุณยินยอมตอนสมัครเท่านั้น</p>

      <div className="mt-4 rounded-xl border border-dashed border-border bg-surface-muted p-5 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => { event.preventDefault(); void upload(event.dataTransfer.files[0]); }}>
        <p className="mb-3 text-sm text-ink-soft">ลากไฟล์ PDF มาวาง หรือเลือกไฟล์ {resumes && `· ${resumes.length} จาก ${MAX_FILES} ไฟล์`}</p>
        <input ref={input} type="file" accept="application/pdf,.pdf" onChange={selectFile} className="sr-only" id="resume-file" disabled={busy || full} />
        <button type="button" onClick={() => input.current?.click()} disabled={busy || full}
          className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50">
          {busy ? 'กำลังดำเนินการ…' : 'อัปโหลดเรซูเม่'}
        </button>
        {full && <span className="ml-3 text-sm text-ink-soft">ครบ {MAX_FILES} ไฟล์แล้ว ลบไฟล์เดิมก่อนจึงจะอัปโหลดเพิ่มได้</span>}
      </div>

      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}

      <div className="mt-4">
        {resumes === null && <p className="text-sm text-ink-soft">กำลังโหลด…</p>}
        {resumes && resumes.length === 0 && (
          <p className="rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-soft">ยังไม่มีเรซูเม่ อัปโหลดไฟล์ PDF เพื่อใช้สมัครงาน</p>
        )}
        {resumes && resumes.length > 0 && (
          <ul className="divide-y divide-border rounded-xl border border-border">
            {resumes.map((resume) => (
              <li key={resume.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <div>
                  <p className="text-sm font-medium">
                    เรซูเม่ ({formatSize(resume.size_bytes)})
                    {resume.is_primary && <span className="ml-2 rounded-full bg-success-soft px-2.5 py-0.5 text-xs font-medium text-success-text">ไฟล์หลัก</span>}
                  </p>
                  <p className="text-xs text-ink-soft">อัปโหลดเมื่อ {dateFormat.format(new Date(resume.uploaded_at))}</p>
                </div>
                <div className="flex items-center gap-4 text-sm">
                  {/* Signed URL อายุ ~10 นาที — เปิดแท็บใหม่ทันที ถ้าหมดอายุให้รีเฟรชหน้า */}
                  <a href={resume.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">เปิดดู</a>
                  <button type="button" onClick={() => setConfirmId(resume.id)} disabled={busy} className="font-medium text-danger-text hover:underline disabled:opacity-50">ลบ</button>
                </div>
                {confirmId === resume.id && (
                  <div className="basis-full rounded-lg bg-warning-soft p-3 text-sm">
                    <p>ใบสมัครที่ใช้ไฟล์นี้จะเปิดเรซูเม่ไม่ได้อีก</p>
                    <div className="mt-2 flex gap-3">
                      <button type="button" onClick={() => setConfirmId(null)} className="font-medium text-primary">ยกเลิก</button>
                      <button type="button" disabled={busy} onClick={() => void remove(resume)} className="font-medium text-danger-text">ยืนยันลบไฟล์</button>
                    </div>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
