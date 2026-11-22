'use client';

import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import type { StudentProfile } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { Avatar } from '@/components/ui/avatar';
import { ApiError } from '@/lib/api';
import { removePhoto, uploadPhoto, validatePhoto } from '@/lib/profile-photo';

// ขีดจำกัดตาม api-contract §7.1 — ตรวจฝั่งหน้าจอเพื่อบอกผู้ใช้เร็ว ค่าจริงตรวจที่ Lifecycle
const HEADLINE_MAX = 200;
const BIO_MAX = 2000;
const SKILLS_MAX = 30;
const SKILL_MAX_LENGTH = 50;
const URL_MAX = 500;

/** แยกทักษะด้วย , หรือขึ้นบรรทัดใหม่ ตัดช่องว่าง และตัดซ้ำโดยไม่สนตัวพิมพ์ (เหมือนที่ Lifecycle ทำ) */
export function parseSkills(text: string): string[] {
  const seen = new Set<string>();
  const skills: string[] = [];
  for (const raw of text.split(/[,\n]/)) {
    const skill = raw.trim();
    const key = skill.toLocaleLowerCase();
    if (skill && !seen.has(key)) { seen.add(key); skills.push(skill); }
  }
  return skills;
}

function validate(headline: string, bio: string, skills: string[], url: string): string | null {
  if (headline.length > HEADLINE_MAX) return `หัวข้อแนะนำตัวต้องไม่เกิน ${HEADLINE_MAX} ตัวอักษร`;
  if (bio.length > BIO_MAX) return `แนะนำตัวต้องไม่เกิน ${BIO_MAX} ตัวอักษร`;
  if (skills.length > SKILLS_MAX) return `ใส่ทักษะได้ไม่เกิน ${SKILLS_MAX} รายการ`;
  if (skills.some((skill) => skill.length > SKILL_MAX_LENGTH)) return `ทักษะแต่ละรายการต้องไม่เกิน ${SKILL_MAX_LENGTH} ตัวอักษร`;
  if (url) {
    if (url.length > URL_MAX) return `ลิงก์ผลงานต้องไม่เกิน ${URL_MAX} ตัวอักษร`;
    if (!/^https?:\/\//i.test(url)) return 'ลิงก์ผลงานต้องขึ้นต้นด้วย http:// หรือ https://';
  }
  return null;
}

const inputClass = 'mt-1 w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary focus:ring-2 focus:ring-primary-soft';

/** โปรไฟล์ที่ยังไม่เคยกรอกอะไร (มีแต่สาขา/ชั้นปีจากบัญชี) — เปิดโหมดแก้ไขให้เลย */
const isBlank = (profile: StudentProfile) =>
  !profile.headline && !profile.bio && !profile.portfolio_url && profile.skills.length === 0;

/**
 * หน้าโปรไฟล์นักศึกษา: โหมดดู (ค่าเริ่มต้น — หน้าตาเหมือนที่ HR เห็นเมื่อได้รับ Consent) สลับเป็นโหมดแก้ไขในที่เดิม
 * ไม่ใช้ Modal: ฟอร์มยาว (แนะนำตัวได้ 2000 ตัวอักษร) และบนมือถือคีย์บอร์ดจะบังฟิลด์
 */
export function ProfileForm() {
  const { request, user } = useAuth();
  const [loaded, setLoaded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [saved, setSaved] = useState<StudentProfile | null>(null);
  const photoInput = useRef<HTMLInputElement>(null);
  const [major, setMajor] = useState<{ major: string; year_level: number } | null>(null);
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [skillsText, setSkillsText] = useState('');
  const [portfolio, setPortfolio] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  function fill(profile: StudentProfile) {
    setSaved(profile);
    setMajor({ major: profile.major, year_level: profile.year_level });
    setHeadline(profile.headline ?? '');
    setBio(profile.bio ?? '');
    setSkillsText(profile.skills.join(', '));
    setPortfolio(profile.portfolio_url ?? '');
  }

  useEffect(() => {
    let cancelled = false;
    request<StudentProfile>('/me/profile').then(
      (profile) => { if (!cancelled) { fill(profile); setEditing(isBlank(profile)); setLoaded(true); } },
      (cause) => {
        if (cancelled) return;
        setMessage({ tone: 'error', text: cause instanceof ApiError ? cause.message : 'โหลดโปรไฟล์ไม่สำเร็จ กรุณาลองใหม่' });
        setLoaded(true);
      },
    );
    return () => { cancelled = true; };
  }, [request]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const skills = parseSkills(skillsText);
    const problem = validate(headline, bio, skills, portfolio.trim());
    if (problem) { setMessage({ tone: 'error', text: problem }); return; }
    setBusy(true);
    setMessage(null);
    try {
      // PUT แทนที่ทั้งชุด: ช่องที่ว่าง = ล้างค่า; ห้ามส่ง major/year_level (สำเนาจาก Identity)
      const saved = await request<StudentProfile>('/me/profile', {
        method: 'PUT',
        // ช่องว่างไม่ส่ง (ไม่ส่ง = ล้างค่า) — ส่งสตริงว่างจะถูกปฏิเสธเป็น 400 (เช่น portfolio_url ว่างไม่ใช่ URL)
        body: {
          ...(headline.trim() ? { headline: headline.trim() } : {}),
          ...(bio.trim() ? { bio: bio.trim() } : {}),
          skills,
          ...(portfolio.trim() ? { portfolio_url: portfolio.trim() } : {}),
        },
      });
      fill(saved);
      setEditing(false);
      setMessage({ tone: 'success', text: 'บันทึกโปรไฟล์แล้ว' });
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof ApiError ? cause.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่' });
    } finally { setBusy(false); }
  }

  if (!loaded) return <p className="text-sm text-ink-soft">กำลังโหลด…</p>;

  async function changePhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const problem = validatePhoto(file);
    if (problem) { setMessage({ tone: 'error', text: problem }); return; }
    setBusy(true);
    setMessage(null);
    try {
      const url = await uploadPhoto(request, file);
      setSaved((current) => (current ? { ...current, photo_url: url } : current));
      setMessage({ tone: 'success', text: 'เปลี่ยนรูปโปรไฟล์แล้ว' });
    } catch (cause) { setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'เปลี่ยนรูปไม่สำเร็จ กรุณาลองใหม่' }); }
    finally { setBusy(false); }
  }

  async function deletePhoto() {
    setBusy(true);
    setMessage(null);
    try {
      await removePhoto(request);
      setSaved((current) => { if (!current) return current; const { photo_url: _removed, ...rest } = current; return rest; });
      setMessage({ tone: 'success', text: 'ลบรูปโปรไฟล์แล้ว' });
    } catch (cause) { setMessage({ tone: 'error', text: cause instanceof Error ? cause.message : 'ลบรูปไม่สำเร็จ กรุณาลองใหม่' }); }
    finally { setBusy(false); }
  }

  function cancelEdit() {
    if (saved) fill(saved); // ทิ้งค่าที่แก้ค้าง กลับเป็นค่าที่บันทึกไว้
    setMessage(null);
    setEditing(false);
  }

  if (!editing && saved) {
    return (
      <section aria-label="โปรไฟล์ของฉัน" className="space-y-5">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex flex-col items-center gap-2">
            <Avatar name={user?.full_name} src={saved.photo_url} size="lg" />
            <input ref={photoInput} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={(event) => void changePhoto(event)} aria-label="เลือกรูปโปรไฟล์" />
            <div className="flex gap-3 text-xs">
              <button type="button" disabled={busy} onClick={() => photoInput.current?.click()} className="font-medium text-primary hover:underline disabled:opacity-60">{saved.photo_url ? 'เปลี่ยนรูป' : 'เพิ่มรูป'}</button>
              {saved.photo_url && <button type="button" disabled={busy} onClick={() => void deletePhoto()} className="font-medium text-danger-text hover:underline disabled:opacity-60">ลบรูป</button>}
            </div>
          </div>
          <div className="min-w-0">
            <h2 className="text-2xl font-semibold">{user?.full_name || 'นักศึกษา'}</h2>
            <p className="text-sm text-ink-soft">{saved.major} · ชั้นปี {saved.year_level}</p>
          </div>
          <button type="button" onClick={() => { setMessage(null); setEditing(true); }}
            className="ml-auto rounded-full border border-border px-5 py-2 text-sm font-semibold hover:bg-surface-muted">
            แก้ไขโปรไฟล์
          </button>
        </div>
        {message && <Notice tone={message.tone}>{message.text}</Notice>}
        {saved.headline && <p className="text-base font-medium">{saved.headline}</p>}
        {saved.bio && <p className="whitespace-pre-line text-sm text-ink-soft">{saved.bio}</p>}
        {saved.skills.length > 0 && (
          <ul aria-label="ทักษะ" className="flex flex-wrap gap-2">
            {saved.skills.map((skill) => <li key={skill} className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-medium text-ink-soft">{skill}</li>)}
          </ul>
        )}
        {saved.portfolio_url && (
          <p className="text-sm"><a href={saved.portfolio_url} target="_blank" rel="noopener noreferrer" className="font-medium text-primary hover:underline">ดูผลงาน</a></p>
        )}
      </section>
    );
  }

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {major && (
        <dl className="grid grid-cols-2 gap-4 rounded-xl bg-surface-muted p-4 text-sm">
          <div><dt className="text-xs text-ink-soft">สาขา</dt><dd className="font-medium">{major.major}</dd></div>
          <div><dt className="text-xs text-ink-soft">ชั้นปี</dt><dd className="font-medium">{major.year_level}</dd></div>
          <p className="col-span-2 text-xs text-ink-soft">สาขาและชั้นปีมาจากข้อมูลบัญชี แก้ไขที่หน้านี้ไม่ได้</p>
        </dl>
      )}
      <label className="block text-sm font-medium">
        หัวข้อแนะนำตัว
        <input value={headline} onChange={(event) => setHeadline(event.target.value)} maxLength={HEADLINE_MAX + 50} className={inputClass} placeholder="เช่น นักศึกษาปี 3 สนใจงานพัฒนาเว็บ" />
        <span className="mt-1 block text-xs font-normal text-ink-soft">{headline.length}/{HEADLINE_MAX}</span>
      </label>
      <label className="block text-sm font-medium">
        แนะนำตัว
        <textarea value={bio} onChange={(event) => setBio(event.target.value)} rows={5} className={inputClass} />
        <span className="mt-1 block text-xs font-normal text-ink-soft">{bio.length}/{BIO_MAX}</span>
      </label>
      <label className="block text-sm font-medium">
        ทักษะ
        <input value={skillsText} onChange={(event) => setSkillsText(event.target.value)} className={inputClass} placeholder="คั่นด้วยเครื่องหมายจุลภาค เช่น Python, SQL, Figma" />
        <span className="mt-1 block text-xs font-normal text-ink-soft">{parseSkills(skillsText).length}/{SKILLS_MAX} รายการ</span>
      </label>
      <label className="block text-sm font-medium">
        ลิงก์ผลงาน
        <input type="url" value={portfolio} onChange={(event) => setPortfolio(event.target.value)} className={inputClass} placeholder="https://" />
      </label>
      {message && <Notice tone={message.tone}>{message.text}</Notice>}
      <div className="flex flex-wrap gap-3">
        <button type="submit" disabled={busy} className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
          {busy ? 'กำลังบันทึก…' : 'บันทึกโปรไฟล์'}
        </button>
        {saved && !isBlank(saved) && (
          <button type="button" onClick={cancelEdit} disabled={busy} className="rounded-full border border-border px-6 py-2.5 font-semibold hover:bg-surface-muted disabled:opacity-60">ยกเลิก</button>
        )}
      </div>
    </form>
  );
}
