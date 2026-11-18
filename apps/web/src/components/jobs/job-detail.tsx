'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { SearchJobItem, WorkMode } from '@internpath/contracts';
import { useAuth } from '@/auth/session';
import { ApplyPanel } from '@/components/jobs/apply-panel';
import { formatDeadline } from '@/components/jobs/job-result-card';
import { getJob } from '@/lib/job-search';
import type { JobDetailResult } from '@/lib/job-search';
import { CATEGORIES } from '@/lib/mock-landing';

const workModeLabel: Record<WorkMode, string> = { ONSITE: 'On-Site', HYBRID: 'Hybrid', REMOTE: 'Remote' };

function Badge({ children, tone }: { children: React.ReactNode; tone: 'success' | 'accent' | 'neutral' | 'warning' }) {
  const styles = {
    success: 'bg-success-soft text-success-text',
    accent: 'bg-accent-soft text-accent',
    neutral: 'bg-surface-muted text-ink-soft',
    warning: 'bg-warning-soft text-warning-text',
  }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><dt className="text-xs text-ink-soft">{label}</dt><dd className="mt-0.5 font-medium">{children}</dd></div>;
}

function TextSection({ title, text }: { title: string; text: string }) {
  return (
    <section className="mt-8">
      <h2 className="text-lg font-bold">{title}</h2>
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
        <Link href={`/login?next=${next}`} className="inline-block rounded-lg bg-primary px-6 py-2.5 text-center font-semibold text-white hover:bg-primary-hover">
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
  const id = useSearchParams().get('id') ?? '';
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
        <h1 className="text-xl font-bold">{state.status === 'missing' ? 'ไม่พบประกาศนี้' : 'โหลดประกาศไม่สำเร็จ'}</h1>
        <p className="mt-2 text-sm text-ink-soft">
          {state.status === 'missing' ? 'ประกาศอาจถูกลบหรือยังไม่เปิดเผยต่อสาธารณะ' : 'ระบบไม่พร้อมใช้งาน กรุณาลองใหม่ภายหลัง'}
        </p>
        <Link href="/jobs" className="mt-4 inline-block text-sm font-medium text-primary hover:underline">กลับไปค้นหางาน</Link>
      </main>
    );
  }

  const { job, rating } = state.data;
  const closed = job.status === 'CLOSED';
  const category = CATEGORIES.find((entry) => entry.id === job.category)?.label ?? job.category;
  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      <Link href="/jobs" className="text-sm font-medium text-primary hover:underline">← กลับไปค้นหางาน</Link>
      {/* MOCK: ข้อมูลตัวอย่าง จนกว่า GET /jobs/{id} จะเปิดให้เรียกโดยไม่ต้องล็อกอิน (ดู src/lib/job-search.ts) */}
      <p className="mt-3 text-xs text-warning-text">ข้อมูลในหน้านี้เป็นข้อมูลจำลอง</p>

      <header className="mt-2">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="neutral">{category}</Badge>
          {job.featured && <Badge tone="accent">Featured</Badge>}
          {closed && <Badge tone="warning">ปิดรับสมัคร</Badge>}
        </div>
        <h1 className="mt-3 text-3xl font-bold">{job.job_title}</h1>
        <p className="mt-1 text-ink-soft">{job.company.name}</p>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {job.company.badges.map((badge) => <Badge key={badge} tone="success">{badge}</Badge>)}
          <span className="text-sm text-ink-soft">
            {rating && rating.review_count > 0 ? `คะแนนรีวิว ${rating.rating_avg.toFixed(1)} (${rating.review_count} รีวิว)` : 'ยังไม่มีรีวิว'}
          </span>
        </div>
      </header>

      <div className="mt-6 grid gap-8 md:grid-cols-[1fr_16rem]">
        <div>
          <dl className="grid grid-cols-2 gap-4 rounded-xl border border-border bg-surface-muted p-4 sm:grid-cols-3">
            <Fact label="ค่าตอบแทน">{job.allowance.text}</Fact>
            <Fact label="รูปแบบการทำงาน">{workModeLabel[job.work_mode]}</Fact>
            <Fact label="สถานที่">{job.location}</Fact>
            <Fact label="ชั่วโมงต่อสัปดาห์">{job.hours_per_week} ชั่วโมง</Fact>
            <Fact label="ช่วงฝึกงาน">{formatDeadline(job.period.start)} – {formatDeadline(job.period.end)}</Fact>
            <Fact label="ปิดรับสมัคร">{formatDeadline(job.application_deadline)}</Fact>
          </dl>

          <TextSection title="รายละเอียดงาน" text={job.description} />
          <TextSection title="หน้าที่ความรับผิดชอบ" text={job.responsibilities} />
          <TextSection title="คุณสมบัติผู้สมัคร" text={job.qualifications} />

          <section className="mt-8">
            <h2 className="text-lg font-bold">สาขาที่เปิดรับ</h2>
            <ul className="mt-2 flex flex-wrap gap-2">
              {job.target_majors.map((major) => <li key={major}><Badge tone="neutral">{major}</Badge></li>)}
            </ul>
          </section>
        </div>

        <aside className="h-fit rounded-xl border border-border bg-surface p-5 shadow-sm md:sticky md:top-6">
          <p className="text-sm text-ink-soft">เปิดรับอีก {job.quota_available} จาก {job.quota} ตำแหน่ง</p>
          <div className="mt-4"><ApplyBox closed={closed} job={job} /></div>
        </aside>
      </div>
    </main>
  );
}
