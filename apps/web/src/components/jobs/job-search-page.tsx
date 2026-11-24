'use client';

import Link from 'next/link';
import { Search, X } from 'lucide-react';
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

  const selectedTags = (query.tags ?? '').split(',').filter(Boolean);
  const workOptions: Array<[WorkMode, string]> = [['ONSITE', 'On-Site'], ['HYBRID', 'Hybrid'], ['REMOTE', 'Remote']];
  const filters = [
    { key: 'q', label: query.q, changes: { q: undefined } },
    { key: 'major', label: query.major, changes: { major: undefined } },
    { key: 'category', label: CATEGORIES.find((item) => item.id === query.category)?.label, changes: { category: undefined } },
    { key: 'work_mode', label: workOptions.find(([value]) => value === query.work_mode)?.[1], changes: { work_mode: undefined } },
    { key: 'allowance', label: query.allowance ? 'มีค่าตอบแทน' : undefined, changes: { allowance: undefined } },
    { key: 'company_id', label: query.company_id ? 'บริษัทที่เลือก' : undefined, changes: { company_id: undefined } },
    ...selectedTags.map((slug) => ({ key: slug, label: tags?.find((tag) => tag.slug === slug)?.name ?? slug,
      changes: { tags: selectedTags.filter((entry) => entry !== slug).join(',') || undefined } })),
  ].filter((filter) => filter.label);
  const chipClass = (active: boolean) => `shrink-0 whitespace-nowrap rounded-full border px-4 py-2 text-sm ${active ? 'border-primary bg-primary-soft font-semibold text-primary' : 'border-border hover:border-primary'}`;
  const totalPages = result ? Math.max(1, Math.ceil(result.meta.total / PAGE_SIZE)) : 1;

  return (
    <main>
      <nav aria-label="เมนูค้นหางาน" className="frosted sticky top-12 z-20 border-b border-border">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-2 sm:px-6">
          <p className="font-semibold">ค้นหางาน</p>
          <div className="hidden gap-4 text-sm sm:flex">
            <Link href="/jobs" className="text-ink-soft hover:text-primary">ประกาศทั้งหมด</Link>
            <Link href="/companies" className="text-ink-soft hover:text-primary">บริษัทและรีวิว</Link>
          </div>
        </div>
      </nav>
      <header className="bg-surface-muted px-4 py-12 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <h1 className="text-4xl font-semibold">ค้นหางานฝึกงาน</h1>
          <p className="mt-2 text-sm text-ink-soft">เลือกจากประกาศที่ผ่านการตรวจสอบแล้ว กรองตามสายงาน รูปแบบการทำงาน และสาขาของคุณ</p>

          <form
            role="search"
            onSubmit={(event) => { event.preventDefault(); update({ q: text.trim() || undefined }); }}
            className="mt-6 flex flex-col gap-3 sm:flex-row"
          >
            <label className="relative flex-1">
              <span className="sr-only">ตำแหน่งหรือชื่อบริษัท</span>
              <Search size={17} className="absolute left-4 top-1/2 -translate-y-1/2 text-ink-soft" aria-hidden="true" />
              <input
                type="search" value={text} onChange={(event) => setText(event.target.value)} placeholder="เช่น Software Engineer"
                className="w-full rounded-full border border-border bg-surface py-2.5 pl-11 pr-5 text-base outline-none focus:border-primary"
              />
            </label>
            <button type="submit" className="rounded-full bg-primary px-6 py-2.5 font-semibold text-white hover:bg-primary-hover">
              ค้นหา
            </button>
          </form>

          {profileMajor && !query.major && (
            <p className="mt-4 text-sm text-ink-soft">
              เทียบกับสาขา <strong className="text-ink">{profileMajor}</strong> จากโปรไฟล์
              <Link href="/student/profile" className="ml-2 text-primary hover:underline">ดูโปรไฟล์ ›</Link>
            </p>
          )}
          <details className="mt-3 text-sm" open={query.major ? true : undefined}>
            <summary className="cursor-pointer text-primary">ระบุสาขาที่ต้องการเทียบ</summary>
            <form className="mt-2 flex flex-wrap gap-2" onSubmit={(event) => { event.preventDefault(); update({ major: major.trim() || undefined }); }}>
              <input type="text" value={major} onChange={(event) => setMajor(event.target.value)}
                aria-label="สาขาของคุณ" placeholder="เช่น วิทยาการคอมพิวเตอร์"
                className="min-w-0 rounded-lg border border-border px-3 py-2" />
              <button type="submit" className="rounded-full border border-primary px-4 py-2 font-semibold text-primary">ใช้สาขานี้</button>
            </form>
          </details>
        </div>
      </header>

      <div className="mx-auto max-w-6xl space-y-4 px-4 py-5 sm:px-6">
        <div className="flex gap-2 overflow-x-auto p-1" role="group" aria-label="สายงาน">
          <button type="button" aria-pressed={!query.category} className={chipClass(!query.category)} onClick={() => update({ category: undefined })}>ทุกสายงาน</button>
          {CATEGORIES.map(({ id, label }) => (
            <button key={id} type="button" aria-pressed={query.category === id} className={chipClass(query.category === id)}
              onClick={() => update({ category: query.category === id ? undefined : id })}>{label}</button>
          ))}
        </div>
        <div className="flex gap-2 overflow-x-auto p-1" role="group" aria-label="รูปแบบการทำงานและค่าตอบแทน">
          {workOptions.map(([value, label]) => (
            <button key={value} type="button" aria-pressed={query.work_mode === value} className={chipClass(query.work_mode === value)}
              onClick={() => update({ work_mode: query.work_mode === value ? undefined : value })}>{label}</button>
          ))}
          <button type="button" aria-pressed={query.allowance === true} className={chipClass(query.allowance === true)}
            onClick={() => update({ allowance: query.allowance ? undefined : 'true' })}>มีค่าตอบแทน</button>
        </div>
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
                  className={`max-w-full rounded-full border px-3 py-1 text-sm [overflow-wrap:anywhere] ${on ? 'border-primary bg-primary-soft text-primary' : 'border-border hover:bg-surface-muted'}`}>
                  {name}
                </button>
              );
            })}
          </div>
        </div>

      </div>
      <section aria-labelledby="results-title" aria-busy={!result && !failed} className="bg-surface-muted px-4 py-8 sm:px-6">
        <div className="mx-auto max-w-6xl">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <h2 id="results-title" className="text-xl font-semibold">
              {failed ? 'โหลดผลการค้นหาไม่สำเร็จ' : result ? `พบ ${result.meta.total} ประกาศ` : 'กำลังโหลด…'}
            </h2>
            <FilterSelect
              label="เรียงตาม" value={query.sort ?? 'newest'} onChange={(value) => update({ sort: value === 'newest' ? undefined : value })}
              options={[['newest', 'ประกาศใหม่ล่าสุด'], ['deadline', 'ใกล้ปิดรับสมัคร']]}
            />
          </div>
          {filters.length > 0 && (
            <div className="mt-3 flex flex-wrap items-center gap-2" aria-label="ตัวกรองที่ใช้อยู่">
              {filters.map(({ key, label, changes }) => (
                <button key={key} type="button" onClick={() => update(changes)} aria-label={`เอาตัวกรอง ${label} ออก`}
                  className="inline-flex max-w-full items-center gap-2 rounded-full border border-border bg-surface px-3 py-1.5 text-sm hover:border-primary">
                  <span className="min-w-0 [overflow-wrap:anywhere]">{label}</span>
                  <X size={14} aria-hidden="true" className="shrink-0" />
                </button>
              ))}
              <button type="button" onClick={() => router.replace(pathname, { scroll: false })} className="text-sm font-medium text-primary hover:underline">ล้างทั้งหมด</button>
            </div>
          )}

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
        </div>
      </section>
    </main>
  );
}
