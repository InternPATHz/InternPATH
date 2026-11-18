'use client';

import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import type { StudentProfile } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { Notice } from '@/components/admin/filter-fields';
import { ApiError } from '@/lib/api';

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

export function ProfileForm() {
  const { request } = useAuth();
  const [loaded, setLoaded] = useState(false);
  const [major, setMajor] = useState<{ major: string; year_level: number } | null>(null);
  const [headline, setHeadline] = useState('');
  const [bio, setBio] = useState('');
  const [skillsText, setSkillsText] = useState('');
  const [portfolio, setPortfolio] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  function fill(profile: StudentProfile) {
    setMajor({ major: profile.major, year_level: profile.year_level });
    setHeadline(profile.headline ?? '');
    setBio(profile.bio ?? '');
    setSkillsText(profile.skills.join(', '));
    setPortfolio(profile.portfolio_url ?? '');
  }

  useEffect(() => {
    let cancelled = false;
    request<StudentProfile>('/me/profile').then(
      (profile) => { if (!cancelled) { fill(profile); setLoaded(true); } },
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
        body: { headline: headline.trim(), bio: bio.trim(), skills, portfolio_url: portfolio.trim() },
      });
      fill(saved);
      setMessage({ tone: 'success', text: 'บันทึกโปรไฟล์แล้ว' });
    } catch (cause) {
      setMessage({ tone: 'error', text: cause instanceof ApiError ? cause.message : 'บันทึกไม่สำเร็จ กรุณาลองใหม่' });
    } finally { setBusy(false); }
  }

  if (!loaded) return <p className="text-sm text-ink-soft">กำลังโหลด…</p>;

  return (
    <form onSubmit={submit} className="space-y-5" noValidate>
      {major && (
        <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-surface-muted p-4 text-sm">
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
      <button type="submit" disabled={busy} className="rounded-lg bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover disabled:cursor-wait disabled:opacity-60">
        {busy ? 'กำลังบันทึก…' : 'บันทึกโปรไฟล์'}
      </button>
    </form>
  );
}
