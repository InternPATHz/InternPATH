'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import type { CompanyDocType, CompanyDocumentItem, CompanyMeResponse, UserMeResponse } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { StatusBadge } from '@/components/ui/status-badge';
import { ApiError } from '@/lib/api';
import { asList } from '@/lib/list';
import { COMPANY_STATUS, statusView } from '@/lib/status-map';

// ขีดจำกัดตาม api-contract §4.3 — ค่าจริงตรวจที่ Identity (ตรวจ MIME จากเนื้อไฟล์)
const LOGO_MAX = 2 * 1024 * 1024;
const DOC_MAX = 5 * 1024 * 1024;

const DOC_LABEL: Record<CompanyDocType, string> = {
  REGISTRATION_CERT: 'หนังสือรับรองบริษัท',
  VAT_CERT: 'ใบทะเบียนภาษีมูลค่าเพิ่ม',
  AUTHORIZATION_LETTER: 'หนังสือมอบอำนาจ',
  OTHER: 'อื่น ๆ',
};

const STATUS_HINT: Record<string, string> = {
  PENDING: 'ผู้ดูแลระบบกำลังตรวจสอบบัญชีและเอกสารของบริษัท ระหว่างนี้ยังสร้างประกาศไม่ได้',
  NEED_MORE_INFO: 'ผู้ดูแลระบบขอข้อมูลเพิ่ม กรุณาส่งเอกสารเพิ่มตามหมายเหตุ แล้วกด "ส่งตรวจอีกครั้ง"',
  // Requirement 2026-11-21: บริษัทปกติเผยแพร่ประกาศได้ทันที (เข้าคิวตรวจเฉพาะบริษัทที่ติดธง UNDER_REVIEW)
  VERIFIED: 'บริษัทผ่านการรับรองแล้ว สร้างและเผยแพร่ประกาศได้',
  REJECTED: 'บริษัทไม่ผ่านการรับรอง หากเห็นว่าผิดพลาดกรุณาติดต่อผู้ดูแลระบบ',
  SUSPENDED: 'บริษัทถูกระงับชั่วคราว ประกาศของบริษัทจะไม่แสดงต่อสาธารณะ',
};

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
const sizeLabel = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base font-normal outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft disabled:cursor-not-allowed disabled:bg-surface-muted disabled:text-ink-soft';
const failure = (cause: unknown) => (cause instanceof ApiError ? cause.message : 'ดำเนินการไม่สำเร็จ กรุณาลองใหม่');

type Message = { tone: 'error' | 'success'; text: string };

export function CompanyPage() {
  const { request } = useAuth();
  const logoInput = useRef<HTMLInputElement>(null);
  const docInput = useRef<HTMLInputElement>(null);
  const [company, setCompany] = useState<CompanyMeResponse | null>(null);
  const [isOwner, setIsOwner] = useState(false);
  const [documents, setDocuments] = useState<CompanyDocumentItem[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [message, setMessage] = useState<Message | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [website, setWebsite] = useState('');
  const [phone, setPhone] = useState('');
  const [docType, setDocType] = useState<CompanyDocType>('REGISTRATION_CERT');

  const load = useCallback(async (resetInfo = true) => {
    try {
      const [me, mine, docs] = await Promise.all([
        request<UserMeResponse>('/users/me'),
        request<CompanyMeResponse>('/companies/me'),
        request<CompanyDocumentItem[] | { data: CompanyDocumentItem[] }>('/companies/me/documents'),
      ]);
      setCompany(mine);
      setIsOwner(me.company?.member_role === 'OWNER');
      setDocuments(asList(docs as never));
      if (resetInfo) {
        setName(mine.name);
        setWebsite(mine.website ?? '');
        setPhone(mine.phone ?? '');
      }
      setLoadError(null);
    } catch (cause) { setLoadError(failure(cause)); }
  }, [request]);

  useEffect(() => { void load(); }, [load]);

  async function run(action: () => Promise<unknown>, success: string, resetInfo = false) {
    setBusy(true);
    setMessage(null);
    try { await action(); await load(resetInfo); setMessage({ tone: 'success', text: success }); }
    catch (cause) { setMessage({ tone: 'error', text: failure(cause) }); }
    finally { setBusy(false); }
  }

  function saveInfo(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) { setMessage({ tone: 'error', text: 'กรุณาระบุชื่อบริษัท' }); return; }
    if (website.trim() && !/^https?:\/\//i.test(website.trim())) { setMessage({ tone: 'error', text: 'เว็บไซต์ต้องขึ้นต้นด้วย http:// หรือ https://' }); return; }
    void run(() => request('/companies/me', {
      method: 'PATCH',
      body: { name: name.trim(), ...(website.trim() ? { website: website.trim() } : {}), ...(phone.trim() ? { phone: phone.trim() } : {}) },
    }), 'บันทึกข้อมูลบริษัทแล้ว', true);
  }

  function pickFile(event: ChangeEvent<HTMLInputElement>, kind: 'logo' | 'doc') {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const lower = file.name.toLowerCase();
    if (kind === 'logo') {
      if (!/^image\/(jpeg|png|webp)$/.test(file.type) && !/\.(jpe?g|png|webp)$/.test(lower)) { setMessage({ tone: 'error', text: 'โลโก้ต้องเป็นไฟล์ jpg, png หรือ webp' }); return; }
      if (file.size > LOGO_MAX) { setMessage({ tone: 'error', text: 'โลโก้ต้องมีขนาดไม่เกิน 2 MB' }); return; }
    } else {
      if (file.type !== 'application/pdf' && !lower.endsWith('.pdf')) { setMessage({ tone: 'error', text: 'เอกสารต้องเป็นไฟล์ PDF' }); return; }
      if (file.size > DOC_MAX) { setMessage({ tone: 'error', text: 'เอกสารต้องมีขนาดไม่เกิน 5 MB' }); return; }
    }
    const form = new FormData();
    form.append('file', file);
    if (kind === 'doc') form.append('doc_type', docType);
    void run(() => request(kind === 'logo' ? '/companies/me/logo' : '/companies/me/documents', { method: 'POST', body: form }),
      kind === 'logo' ? 'อัปโหลดโลโก้แล้ว' : 'อัปโหลดเอกสารแล้ว');
  }

  if (loadError) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><Notice tone="error">{loadError}</Notice></main>;
  if (!company) return <main className="mx-auto max-w-3xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;

  const view = statusView(COMPANY_STATUS, company.status);
  const canEdit = isOwner && !busy;
  return (
    <main className="mx-auto max-w-5xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">บริษัทของฉัน</h1>

      <ol aria-label="ขั้นตอนการรับรองบริษัท" className="mt-6 grid grid-cols-3 gap-2">
        {['ส่งข้อมูลบริษัท', 'ตรวจสอบเอกสาร', 'ผ่านการรับรอง'].map((label, index) => {
          const current = company.status === 'VERIFIED' ? 2 : company.status === 'SUSPENDED' ? null : 1;
          return <li key={label} aria-current={current === index ? 'step' : undefined}
            className={`border-t-2 pt-2 text-sm ${current !== null && index <= current ? 'border-primary font-semibold' : 'border-border text-ink-soft'}`}>{label}</li>;
        })}
      </ol>
      <section aria-labelledby="status-title"
        className={`mt-6 rounded-xl p-5 ${company.status === 'NEED_MORE_INFO' ? 'bg-tile text-white' : 'bg-surface-muted'}`}>
        <div className="flex flex-wrap items-center gap-3">
          <h2 id="status-title" className="text-lg font-semibold">{company.status === 'NEED_MORE_INFO' ? 'ผู้ดูแลระบบขอเอกสารเพิ่ม' : 'สถานะบัญชีบริษัท'}</h2>
          <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>
        </div>
        <p className={`mt-2 text-sm ${company.status === 'NEED_MORE_INFO' ? 'text-white/75' : 'text-ink-soft'}`}>{STATUS_HINT[company.status] ?? ''}</p>
        {company.review_note && <p className="mt-2 text-sm"><span className="font-medium">หมายเหตุจากผู้ดูแลระบบ:</span> {company.review_note}</p>}
        {company.status === 'NEED_MORE_INFO' && isOwner && (
          <div className="mt-3 flex flex-wrap items-center gap-3">
          <a href="#docs-title" className="text-sm font-medium text-primary-on-dark hover:underline">ไปที่เอกสารยืนยัน ›</a>
          <button type="button" disabled={busy} onClick={() => void run(() => request('/companies/me/resubmit', { method: 'POST' }), 'ส่งตรวจอีกครั้งแล้ว')}
            className="mt-3 rounded-full bg-primary px-5 py-2 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">ส่งตรวจอีกครั้ง</button>
          </div>
        )}
        {company.status === 'NEED_MORE_INFO' && !isOwner && <p className="mt-2 text-xs text-white/75">เฉพาะเจ้าของบัญชี (Owner) ที่ส่งเอกสารและส่งตรวจใหม่ได้</p>}
      </section>

      {message && <div className="mt-4"><Notice tone={message.tone}>{message.text}</Notice></div>}
      {!isOwner && <p className="mt-4 text-xs text-ink-soft">คุณเป็นสมาชิก HR ดูข้อมูลได้อย่างเดียว การแก้ไขเป็นสิทธิ์ของเจ้าของบัญชี (Owner)</p>}

      <div className="mt-8 grid items-start gap-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <section aria-labelledby="info-title" className="min-w-0 rounded-xl border border-border p-4 sm:p-5">
          <h2 id="info-title" className="text-lg font-semibold">ข้อมูลบริษัท</h2>
          <div className="mt-3 flex items-center gap-4">
            <Avatar name={company.name} src={company.logo_url} size="lg" />
            {isOwner && (
              <div>
                <input ref={logoInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => pickFile(event, 'logo')} aria-label="เลือกไฟล์โลโก้" />
                <button type="button" disabled={!canEdit} onClick={() => logoInput.current?.click()} className="rounded-full border border-border px-4 py-2 text-sm font-semibold hover:bg-surface-muted disabled:opacity-60">เปลี่ยนโลโก้</button>
                <p className="mt-1 text-xs text-ink-soft">jpg, png หรือ webp ไม่เกิน 2 MB (โลโก้แสดงต่อสาธารณะ)</p>
              </div>
            )}
          </div>
          <form onSubmit={saveInfo} noValidate className="mt-4 space-y-4">
            <label className="block text-sm font-medium">ชื่อบริษัท
              <input value={name} onChange={(event) => setName(event.target.value)} disabled={!isOwner} className={inputClass} />
            </label>
            <label className="block text-sm font-medium">เลขทะเบียนนิติบุคคล
              <input value={company.registration_no} disabled className={inputClass} />
            </label>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block text-sm font-medium">เว็บไซต์
                <input value={website} onChange={(event) => setWebsite(event.target.value)} disabled={!isOwner} className={inputClass} placeholder="https://" />
              </label>
              <label className="block text-sm font-medium">โทรศัพท์
                <input value={phone} onChange={(event) => setPhone(event.target.value)} disabled={!isOwner} className={inputClass} />
              </label>
            </div>
            {isOwner && <button type="submit" disabled={busy} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:opacity-60">บันทึกข้อมูล</button>}
          </form>
        </section>

        <section aria-labelledby="docs-title" className="mt-10">
          <h2 id="docs-title" className="scroll-mt-20 text-lg font-semibold">เอกสารยืนยันบริษัท</h2>
          <p className="mt-1 text-sm text-ink-soft">ไฟล์ PDF ไม่เกิน 5 MB เก็บแบบส่วนตัว เปิดดูได้เฉพาะสมาชิกบริษัทและผู้ดูแลระบบ</p>
          {isOwner && (
            <div className="mt-3 flex flex-wrap items-end gap-3">
              <label className="text-sm font-medium">ประเภทเอกสาร
                <select value={docType} onChange={(event) => setDocType(event.target.value as CompanyDocType)} className={inputClass}>
                  {(Object.keys(DOC_LABEL) as CompanyDocType[]).map((type) => <option key={type} value={type}>{DOC_LABEL[type]}</option>)}
                </select>
              </label>
              <input ref={docInput} type="file" accept="application/pdf,.pdf" className="sr-only" onChange={(event) => pickFile(event, 'doc')} aria-label="เลือกไฟล์เอกสาร" />
              <button type="button" disabled={!canEdit} onClick={() => docInput.current?.click()} className="rounded-full bg-primary px-5 py-2.5 text-sm font-semibold text-white hover:bg-primary-hover disabled:opacity-60">อัปโหลดเอกสาร</button>
            </div>
          )}
          {documents.length === 0 ? (
            <p className="mt-4 rounded-xl border border-dashed border-border p-6 text-center text-sm text-ink-soft">ยังไม่มีเอกสาร</p>
          ) : (
            <ul className="mt-4 divide-y divide-border rounded-xl border border-border">
              {documents.map((doc) => (
                <li key={doc.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                  <div>
                    <p className="font-medium">{DOC_LABEL[doc.doc_type] ?? doc.doc_type} ({sizeLabel(doc.size_bytes)})</p>
                    <p className="text-xs text-ink-soft">อัปโหลดเมื่อ {dateFormat.format(new Date(doc.created_at))}</p>
                  </div>
                  <a href={doc.url} target="_blank" rel="noreferrer" className="font-medium text-primary hover:underline">เปิดดู</a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
