'use client';

import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { JobCategory, JobTag, SearchJobsQuery, StudentProfile, WorkMode } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { FilterSelect } from '@/components/admin/filter-fields';
import { JobResultCard } from '@/components/jobs/job-result-card';
import { CATEGORIES } from '@/lib/categories';
import { PAGE_SIZE, listTags, searchJobs } from '@/lib/job-search';
import type { JobSearchResult } from '@/lib/job-search';

const CATEGORY_IDS = CATEGORIES.map((entry) => entry.id);
const WORK_MODES: WorkMode[] = ['ONSITE', 'HYBRID', 'REMOTE'];
const SORTS = ['newest', 'deadline'] as const;

/** อ่านพารามิเตอร์จาก URL แล้วกรองค่าที่ไม่รู้จักทิ้ง (URL เป็นข้อมูลจากภายนอก) */
function readQuery(params: URLSearchParams): { query: SearchJobsQuery; page: number } {
  const category = params.get('category');
  const workMode = params.get('work_mode');
  const sort = params.get('sort');
  const page = Number(params.get('page'));
  return {
    query: {
      q: params.get('q')?.trim() || undefined,
      category: CATEGORY_IDS.includes(category as JobCategory) ? (category as JobCategory) : undefined,
      work_mode: WORK_MODES.includes(workMode as WorkMode) ? (workMode as WorkMode) : undefined,
      major: params.get('major')?.trim() || undefined,
      // slug ของ Tag คั่นด้วยจุลภาค — กรองเฉพาะรูปแบบที่ปลอดภัย (URL เป็นข้อมูลจากภายนอก)
      tags: (params.get('tags') ?? '').split(',').map((slug) => slug.trim().toLowerCase()).filter((slug) => /^[a-z0-9-]{1,50}$/.test(slug)).join(',') || undefined,
      allowance: params.get('allowance') === 'true' ? true : undefined,
      // ลิงก์จากหน้าบริษัท — ต้องเป็น UUID เท่านั้น (URL เป็นข้อมูลจากภายนอก)
      company_id: /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(params.get('company_id') ?? '') ? (params.get('company_id') as string) : undefined,
      sort: SORTS.includes(sort as (typeof SORTS)[number]) ? (sort as (typeof SORTS)[number]) : 'newest',
    },
    page: Number.isInteger(page) && page >= 1 ? page : 1,
  };
}

export function JobSearchPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { query, page } = readQuery(searchParams);
  const key = searchParams.toString();

  const [result, setResult] = useState<JobSearchResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [text, setText] = useState(query.q ?? '');
  const [major, setMajor] = useState(query.major ?? '');
  const { user, request } = useAuth();
  const [profileMajor, setProfileMajor] = useState<string | undefined>(undefined);
  const [tags, setTags] = useState<JobTag[] | null>(null);
  const [tagsFailed, setTagsFailed] = useState(false);

  // Tag ทักษะที่เปิดใช้งาน — โหลดครั้งเดียว; โหลดไม่ได้ก็ยังค้นหาด้วยตัวกรองอื่นได้
  useEffect(() => {
    let cancelled = false;
    listTags().then(
      (next) => { if (!cancelled) setTags(next); },
      () => { if (!cancelled) setTagsFailed(true); },
    );
    return () => { cancelled = true; };
  }, []);

  // นักศึกษาที่ล็อกอิน: ใช้สาขาจากโปรไฟล์เทียบกับประกาศโดยอัตโนมัติ (เทียบแบบตรงทั้งค่า จึงไม่ให้เดาจากการพิมพ์)
  // เก็บเป็น state ไม่ใส่ใน URL เพื่อไม่ให้ข้อมูลส่วนตัวไปอยู่ในลิงก์ที่แชร์ได้
  const isStudent = user?.role === 'STUDENT';
  useEffect(() => {
    if (!isStudent) { setProfileMajor(undefined); return undefined; }
    let cancelled = false;
    request<StudentProfile>('/me/profile').then(
      (profile) => { if (!cancelled) setProfileMajor(profile.major); },
      () => { /* ไม่มีโปรไฟล์/โหลดไม่ได้ ⇒ ไม่เตือนสาขา (ผู้ใช้ยังพิมพ์เองได้) */ },
    );
    return () => { cancelled = true; };
  }, [isStudent, request]);

  // โหลดผลลัพธ์ใหม่ทุกครั้งที่ตัวกรอง/หน้าใน URL เปลี่ยน; `cancelled` กันผลของคำขอเก่าทับคำขอใหม่
  useEffect(() => {
    let cancelled = false;
    const current = readQuery(new URLSearchParams(key));
    setFailed(false);
    searchJobs({ ...current.query, major: current.query.major ?? profileMajor }, current.page).then(
      (next) => { if (!cancelled) setResult(next); },
      () => { if (!cancelled) setFailed(true); },
    );
    return () => { cancelled = true; };
  }, [key, profileMajor]);

  // ให้ช่องข้อความตรงกับ URL เมื่อผู้ใช้กดย้อนกลับ/ล้างตัวกรอง
  useEffect(() => {
    setText(query.q ?? '');
    setMajor(query.major ?? '');
  }, [query.q, query.major]);

  function update(changes: Record<string, string | undefined>, keepPage = false) {
    const next = new URLSearchParams(searchParams.toString());
    for (const [name, value] of Object.entries(changes)) {
      if (value) next.set(name, value); else next.delete(name);
    }
    if (!keepPage) next.delete('page');
    const qs = next.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }

  const hasFilters = Boolean(query.q || query.category || query.work_mode || query.major || query.tags || query.allowance || query.company_id);
  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;

  return (
    <main className="mx-auto max-w-6xl px-4 py-10 sm:px-6">
      <h1 className="text-3xl font-semibold">ค้นหางานฝึกงาน</h1>
      <p className="mt-2 text-sm text-ink-soft">เลือกจากประกาศที่ผ่านการตรวจสอบแล้ว กรองตามสายงาน รูปแบบการทำงาน และสาขาของคุณ</p>

      <form
        role="search"
        onSubmit={(event) => { event.preventDefault(); update({ q: text.trim() || undefined, major: major.trim() || undefined }); }}
        className="mt-6 grid gap-3 rounded-xl bg-surface-muted p-4 md:grid-cols-[2fr_1fr_auto]"
      >
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">ตำแหน่งหรือชื่อบริษัท</span>
          <input
            type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="เช่น Software Engineer"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary"
          />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-xs font-medium text-ink-soft">สาขาของคุณ (ใช้เตือนเมื่อไม่ตรง)</span>
          <input
            type="text" value={major} onChange={(event) => setMajor(event.target.value)}
            placeholder={profileMajor ? `ใช้สาขาจากโปรไฟล์: ${profileMajor}` : 'เช่น วิทยาการคอมพิวเตอร์'}
            aria-describedby="major-hint"
            className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-base outline-none focus:border-primary"
          />
          <span id="major-hint" className="mt-1 block text-xs text-ink-soft">
            {profileMajor ? 'ใช้สาขาจากโปรไฟล์ของคุณอยู่ พิมพ์ที่นี่เพื่อเปลี่ยน' : 'พิมพ์ชื่อสาขาให้ตรงกับที่ประกาศระบุ จึงจะเทียบได้ถูกต้อง'}
          </span>
        </label>
        <button type="submit" className="self-end rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover">
          ค้นหา
        </button>
      </form>

      <div className="mt-4" role="group" aria-label="กรองตาม Tag ทักษะ">
        <span className="mb-1 block text-xs font-medium text-ink-soft">Tag ทักษะ (เลือกได้หลายรายการ — แสดงประกาศที่มี Tag ใดก็ได้)</span>
        <div className="flex flex-wrap gap-2">
          {tagsFailed && <span className="text-sm text-ink-soft">โหลดรายการ Tag ไม่สำเร็จ</span>}
          {!tags && !tagsFailed && <span className="text-sm text-ink-soft">กำลังโหลด…</span>}
          {tags?.length === 0 && <span className="text-sm text-ink-soft">ยังไม่มี Tag ทักษะ</span>}
          {tags?.map(({ slug, name }) => {
            const selected = (query.tags ?? '').split(',').filter(Boolean);
            const on = selected.includes(slug);
            return (
              <button key={slug} type="button" aria-pressed={on}
                onClick={() => update({ tags: (on ? selected.filter((entry) => entry !== slug) : [...selected, slug]).join(',') || undefined })}
                className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
                {name}
              </button>
            );
          })}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-end gap-4">
        <FilterSelect
          label="สายงาน" value={query.category ?? ''} onChange={(value) => update({ category: value || undefined })}
          options={[['', 'ทุกสายงาน'], ...CATEGORIES.map((entry): [string, string] => [entry.id, entry.label])]}
        />
        <FilterSelect
          label="รูปแบบการทำงาน" value={query.work_mode ?? ''} onChange={(value) => update({ work_mode: value || undefined })}
          options={[['', 'ทั้งหมด'], ['ONSITE', 'On-Site'], ['HYBRID', 'Hybrid'], ['REMOTE', 'Remote']]}
        />
        <FilterSelect
          label="เรียงตาม" value={query.sort ?? 'newest'} onChange={(value) => update({ sort: value === 'newest' ? undefined : value })}
          options={[['newest', 'ประกาศใหม่ล่าสุด'], ['deadline', 'ใกล้ปิดรับสมัคร']]}
        />
        <label className="flex items-center gap-2 pb-2 text-sm">
          <input
            type="checkbox" checked={query.allowance === true} onChange={(event) => update({ allowance: event.target.checked ? 'true' : undefined })}
            className="h-4 w-4 accent-primary"
          />
          เฉพาะงานที่มีค่าตอบแทน
        </label>
        {hasFilters && (
          <button
            type="button" onClick={() => router.replace(pathname, { scroll: false })}
            className="pb-2 text-sm font-medium text-primary hover:underline"
          >
            ล้างตัวกรอง
          </button>
        )}
      </div>

      <section aria-labelledby="results-title" aria-busy={!result && !failed} className="mt-6">
        <h2 id="results-title" className="text-sm text-ink-soft">
          {failed ? 'โหลดผลการค้นหาไม่สำเร็จ' : result ? `พบ ${result.meta.total} ประกาศ` : 'กำลังโหลด…'}
        </h2>

        {failed && (
          <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-4 py-3 text-sm text-danger-text">
            ระบบค้นหาไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง
          </p>
        )}

        {result && result.jobs.length === 0 && (
          <div className="mt-4 rounded-xl border border-dashed border-border p-10 text-center">
            <p className="font-semibold">ไม่พบประกาศที่ตรงกับเงื่อนไข</p>
            <p className="mt-1 text-sm text-ink-soft">ลองลดตัวกรอง หรือค้นด้วยคำที่กว้างขึ้น</p>
          </div>
        )}

        {result && result.jobs.length > 0 && (
          <ul className="mt-4 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {result.jobs.map((job) => (
              <li key={job.id} className="contents"><JobResultCard job={job} rating={result.ratings[job.company.id]} /></li>
            ))}
          </ul>
        )}

        {result && result.meta.total > PAGE_SIZE && (
          <nav aria-label="เลือกหน้า" className="mt-8 flex items-center justify-center gap-4 text-sm">
            <button
              type="button" disabled={page <= 1} onClick={() => update({ page: String(page - 1) }, true)}
              className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              ก่อนหน้า
            </button>
            <span aria-live="polite">หน้า {page} จาก {totalPages}</span>
            <button
              type="button" disabled={page >= totalPages} onClick={() => update({ page: String(page + 1) }, true)}
              className="rounded-full border border-border px-4 py-2 font-medium disabled:cursor-not-allowed disabled:opacity-40"
            >
              ถัดไป
            </button>
          </nav>
        )}
      </section>
    </main>
  );
}
