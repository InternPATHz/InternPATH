'use client';

import Link from 'next/link';
import { catalogHref } from '@/lib/catalog-navigation';
import { Avatar } from '@/components/ui/avatar';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { SearchJobItem, WorkMode } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { ApplyPanel } from '@/components/jobs/apply-panel';
import { formatDeadline } from '@/components/jobs/job-result-card';
import { ReportPanel } from '@/components/reports/report-panel';
import { getJob } from '@/lib/job-search';
import type { JobDetailResult } from '@/lib/job-search';
import { StatusBadge } from '@/components/ui/status-badge';
import { allowanceLabel } from '@/lib/allowance';
import { CATEGORIES } from '@/lib/categories';
import { JOB_STATUS, statusView } from '@/lib/status-map';

const workModeLabel: Record<WorkMode, string> = { ONSITE: 'On-Site', HYBRID: 'Hybrid', REMOTE: 'Remote' };

function Badge({ children, tone }: { children: React.ReactNode; tone: 'success' | 'accent' | 'neutral' | 'warning' }) {
  const styles = {
    success: 'bg-success-soft text-success-text',
    accent: 'bg-accent-soft text-accent-text',
    neutral: 'bg-surface-muted text-ink-soft',
    warning: 'bg-warning-soft text-warning-text',
  }[tone];
  return <span className={`inline-block max-w-full rounded-full px-2.5 [overflow-wrap:anywhere] py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>;
}

function TextSection({ title, text }: { title: string; text: string }) {
  return (
    <section className="mt-6 rounded-xl bg-surface-muted p-5">
      <h2 className="text-lg font-semibold">{title}</h2>
      <p className="mt-2 whitespace-pre-line text-ink-soft">{text}</p>
    </section>
  );
}

/** ปุ่ม/ข้อความสมัครตามสถานะผู้ใช้ — การสมัครจริงอยู่ใน ApplyPanel (POST /applications ของ Lifecycle) */
function ApplyBox({ closed, job }: { closed: boolean; job: SearchJobItem }) {
  const { ready, user } = useAuth();
  if (closed) return <p className="text-sm text-ink-soft">ประกาศนี้ปิดรับสมัครแล้ว</p>;
  if (!ready) return <p className="text-sm text-ink-soft">กำลังตรวจสอบสถานะผู้ใช้…</p>;
  if (!user) {
    const next = encodeURIComponent(`/jobs/item?id=${job.id}`);
    return (
      <div className="flex flex-col gap-2">
        <Link href={`/login?next=${next}`} className="inline-block rounded-full bg-primary px-6 py-2.5 text-center font-semibold text-white hover:bg-primary-hover">
          เข้าสู่ระบบเพื่อสมัคร
        </Link>
        <p className="text-xs text-ink-soft">สมัครได้เฉพาะนักศึกษาที่ยืนยันอีเมลสถาบันแล้ว</p>
      </div>
    );
  }
  if (user.role !== 'STUDENT') return <p className="text-sm text-ink-soft">เฉพาะบัญชีนักศึกษาที่สมัครงานได้</p>;
  return <ApplyPanel job={job} />;
}

export function JobDetail() {
  const params = useSearchParams();
  const id = params.get('id') ?? '';
  const backHref = catalogHref('/jobs', params);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'missing' } | { status: 'error' } | { status: 'ready'; data: JobDetailResult }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    if (!id) { setState({ status: 'missing' }); return; }
    getJob(id).then(
      (data) => { if (!cancelled) setState(data ? { status: 'ready', data } : { status: 'missing' }); },
      () => { if (!cancelled) setState({ status: 'error' }); },
    );
    return () => { cancelled = true; };
  }, [id]);

  if (state.status === 'loading') {
    return <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6"><p className="text-sm text-ink-soft">กำลังโหลด…</p></main>;
  }
  if (state.status === 'missing' || state.status === 'error') {
    return (
      <main className="mx-auto max-w-md px-4 py-16 text-center">
        <h1 className="text-xl font-semibold">{state.status === 'missing' ? 'ไม่พบประกาศนี้' : 'โหลดประกาศไม่สำเร็จ'}</h1>
        <p className="mt-2 text-sm text-ink-soft">
          {state.status === 'missing' ? 'ประกาศอาจถูกลบหรือยังไม่เปิดเผยต่อสาธารณะ' : 'ระบบไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง'}
        </p>
        <Link href={backHref} className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปค้นหางาน</Link>
      </main>
    );
  }

  const { job, rating } = state.data;
  const closed = job.status === 'CLOSED';
  const category = CATEGORIES.find((entry) => entry.id === job.category)?.label ?? job.category;
  return (
    <main className="mx-auto max-w-6xl px-4 pb-8 [overflow-wrap:anywhere] sm:px-6">
      <div className="frosted sticky top-12 z-20 -mx-4 flex min-w-0 items-center justify-between gap-3 border-b border-border px-4 py-2 sm:-mx-6 sm:px-6">
        <div className="min-w-0">
          <Link href={backHref} className="text-xs font-medium text-primary hover:underline">← กลับไปค้นหางาน</Link>
          <p className="truncate text-sm font-semibold">{job.job_title}</p>
        </div>
        {!closed && <a href="#apply" className="hidden shrink-0 rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white hover:bg-primary-hover md:inline-block">สมัครงานนี้</a>}
      </div>

      <header className="mx-auto max-w-3xl py-10 text-center">
        <div className="flex flex-wrap items-center justify-center gap-2">
          <Badge tone="neutral">{category}</Badge>
          {job.featured && <Badge tone="accent">Featured</Badge>}
          {closed && <StatusBadge tone={statusView(JOB_STATUS, 'CLOSED').tone} icon={statusView(JOB_STATUS, 'CLOSED').icon}>ปิดรับสมัคร</StatusBadge>}
        </div>
        <h1 className="mt-4 text-4xl font-semibold sm:text-5xl">{job.job_title}</h1>
        <p className="mt-1 text-ink-soft">{job.company.name}</p>
        <p className="mx-auto mt-3 line-clamp-2 max-w-2xl break-words text-base text-ink-soft">{job.description.split(/\n\s*\n/, 1)[0]}</p>
        <div className="mt-3 flex flex-wrap items-center justify-center gap-2">
          {job.company.badges.map((badge) => <Badge key={badge} tone="success">{badge}</Badge>)}
          <span className="text-sm text-ink-soft">
            {rating && rating.review_count > 0 ? `คะแนนรีวิว ${rating.rating_avg.toFixed(1)} (${rating.review_count} รีวิว)` : 'ยังไม่มีรีวิว'}
          </span>
        </div>
      </header>

      <dl className="grid grid-cols-2 gap-4 border-y border-border px-3 py-5 text-center sm:grid-cols-4 [&_dd]:mt-0 [&_dd]:text-lg [&_dd]:font-semibold [&_div]:flex [&_div]:flex-col-reverse">
        <Fact label="ค่าตอบแทน">{allowanceLabel(job.allowance)}</Fact>
        <Fact label="รูปแบบการทำงาน">{workModeLabel[job.work_mode]}</Fact>
        <Fact label="ชั่วโมงต่อสัปดาห์">{job.hours_per_week} ชั่วโมง</Fact>
        <Fact label="ช่วงฝึกงาน">{formatDeadline(job.period.start)} – {formatDeadline(job.period.end)}</Fact>
      </dl>
      <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1fr)_18rem]">
        <div className="min-w-0">
          <dl className="flex flex-wrap gap-5 border-b border-border pb-4">
            <Fact label="สถานที่">{job.location}</Fact>
            <Fact label="ปิดรับสมัคร">{formatDeadline(job.application_deadline)}</Fact>
          </dl>
          <TextSection title="รายละเอียดงาน" text={job.description} />
          <TextSection title="หน้าที่ความรับผิดชอบ" text={job.responsibilities} />
          <TextSection title="คุณสมบัติผู้สมัคร" text={job.qualifications} />

          {job.tags.length > 0 && (
            <section className="mt-8">
              <h2 className="text-lg font-semibold">ทักษะที่เกี่ยวข้อง</h2>
              <ul className="mt-2 flex flex-wrap gap-2">
                {job.tags.map((tag) => (
                  <li key={tag.id} className="max-w-full">
                    <Link href={`/jobs?tags=${encodeURIComponent(tag.slug)}`} aria-label={`ค้นหางานที่ใช้ทักษะ ${tag.name}`}
                      className="inline-block rounded-full border border-border px-3 py-1 text-sm hover:border-primary hover:text-primary">
                      {tag.name}
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}

          <section className="mt-8">
            <h2 className="text-lg font-semibold">สาขาที่เปิดรับ</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {job.target_majors.map((major) => <li key={major} className="max-w-full"><Badge tone="neutral">{major}</Badge></li>)}
            </ul>
          </section>
        </div>

        <aside id="apply" className="h-fit scroll-mt-28 rounded-xl border border-border bg-surface p-5 md:sticky md:top-28">
          <h2 className="mb-2 text-xl font-semibold">สมัครงานนี้</h2>
          <p className="text-sm text-ink-soft lg:hidden">เปิดรับอีก {job.quota_available} จาก {job.quota} ตำแหน่ง</p>
          <div className="hidden space-y-2 lg:block">
            <p className="flex flex-wrap justify-between gap-x-2 text-sm text-ink-soft">
              <span>ตำแหน่งที่เหลือ</span>
              <strong className="font-semibold tabular-nums text-ink">{job.quota_available} จาก {job.quota}</strong>
            </p>
            {job.quota > 0 && (
              <div role="meter" aria-label="ตำแหน่งที่เหลือ" aria-valuemin={0} aria-valuemax={job.quota}
                aria-valuenow={job.quota_available} aria-valuetext={`${job.quota_available} จาก ${job.quota} ตำแหน่ง`}
                className="h-1 overflow-hidden rounded-full bg-border forced-colors:bg-[Canvas] forced-colors:outline">
                <span className="block h-full bg-ink forced-colors:bg-[CanvasText] forced-colors:forced-color-adjust-none"
                  style={{ width: `${(job.quota_available / job.quota) * 100}%` }} />
              </div>
            )}
          </div>
          <div className="mt-4"><ApplyBox closed={closed} job={job} /></div>
          {/* รายงานได้เฉพาะประกาศ PUBLISHED/CLOSED (หน้านี้แสดงเฉพาะสองสถานะนี้) — ผู้เยี่ยมชมเห็นลิงก์เข้าสู่ระบบ */}
          <div className="mt-5 border-t border-border pt-4">
            <ReportPanel kind="job" targetId={job.id} loginNext={`/jobs/item?id=${job.id}`} />
          </div>
        </aside>
      </div>
      <section className="mt-10 rounded-xl bg-tile p-6 text-white sm:p-8">
        <div className="flex flex-wrap items-center gap-4">
          <Avatar name={job.company.name} src={job.company.logo_url} />
          <div>
            <p className="text-sm text-white/75">เกี่ยวกับบริษัท</p>
            <h2 className="text-xl font-semibold">{job.company.name}</h2>
          </div>
        </div>
        <Link href={`/companies/item?id=${job.company.id}`} className="mt-4 inline-block text-primary-on-dark hover:underline">ดูข้อมูลบริษัทและรีวิว ›</Link>
      </section>
      {!closed && (
        <div className="frosted sticky bottom-0 z-10 mt-6 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 md:hidden">
          <p className="text-sm">ว่าง {job.quota_available} ตำแหน่ง</p>
          <a href="#apply" className="rounded-full bg-primary px-4 py-2 text-sm font-semibold text-white">ไปที่ส่วนสมัคร</a>
        </div>
      )}
    </main>
  );
}
