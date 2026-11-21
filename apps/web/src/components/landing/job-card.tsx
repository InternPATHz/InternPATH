import Link from 'next/link';
import type { WorkMode } from '@internpath/contracts';
import { CATEGORIES } from '@/lib/mock-landing';
import type { LandingJob } from '@/lib/mock-landing';

const workModeLabel: Record<WorkMode, string> = { ONSITE: 'On-Site', HYBRID: 'Hybrid', REMOTE: 'Remote' };

// ป้ายของบริษัทตาม README §8: Verified / University Partner ใช้สีเขียว (ความน่าเชื่อถือ), Featured ใช้สีม่วง (บริการเสริม ไม่ใช่ความน่าเชื่อถือ)
function Badge({ children, tone }: { children: React.ReactNode; tone: 'success' | 'accent' | 'neutral' }) {
  const styles = {
    success: 'bg-success-soft text-success-text',
    accent: 'bg-accent-soft text-accent-text',
    neutral: 'bg-surface-muted text-ink-soft',
  }[tone];
  return <span className={`inline-block rounded-full px-2.5 py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

export function JobCard({ item }: { item: LandingJob }) {
  const { job, rating } = item;
  const category = CATEGORIES.find((entry) => entry.id === job.category)?.label ?? job.category;
  return (
    <article className="flex flex-col rounded-xl border border-border bg-surface p-5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{category}</Badge>
        {job.featured && <Badge tone="accent">Featured</Badge>}
      </div>
      <h3 className="mt-3 text-lg font-semibold">{job.job_title}</h3>
      <p className="mt-1 text-sm text-ink-soft">{job.company.name}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {job.company.badges.map((badge) => <Badge key={badge} tone="success">{badge}</Badge>)}
      </div>
      <dl className="mt-4 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-ink-soft">
        <div><dt className="sr-only">ค่าตอบแทน</dt><dd>{job.allowance.text}</dd></div>
        <div>
          <dt className="sr-only">คะแนนรีวิว</dt>
          <dd>{rating.review_count > 0 ? `${rating.rating_avg.toFixed(1)} (${rating.review_count} รีวิว)` : 'ยังไม่มีรีวิว'}</dd>
        </div>
        <div><dt className="sr-only">รูปแบบการทำงาน</dt><dd>{workModeLabel[job.work_mode]}</dd></div>
      </dl>
      <Link
        href={`/jobs/item?id=${job.id}`}
        className="mt-auto inline-block self-start pt-5 text-sm text-primary hover:underline"
      >
        ดูรายละเอียด ›
      </Link>
    </article>
  );
}
