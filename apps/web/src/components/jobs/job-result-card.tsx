import Link from 'next/link';
import type { SearchJobItem } from '@internpath/contracts';
import { allowanceLabel } from '@/lib/allowance';
import { Avatar } from '@/components/ui/avatar';
import { CATEGORIES } from '@/lib/categories';
import type { CompanyRating } from '@/lib/job-search';
import { WORK_MODE_LABEL } from '@/lib/work-mode';

// ป้ายตาม README §8: Verified / University Partner ใช้สีเขียว, Featured ใช้สีม่วง, คำเตือนสาขาไม่ตรงใช้สีเหลือง
function Badge({ children, tone }: { children: React.ReactNode; tone: 'success' | 'accent' | 'neutral' | 'warning' }) {
  const styles = {
    success: 'bg-success-soft text-success-text',
    accent: 'bg-accent-soft text-accent-text',
    neutral: 'bg-surface-muted text-ink-soft',
    warning: 'bg-warning-soft text-warning-text',
  }[tone];
  return <span className={`inline-block max-w-full rounded-full px-2.5 [overflow-wrap:anywhere] py-0.5 text-xs font-medium ${styles}`}>{children}</span>;
}

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });

const bangkokDay = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Bangkok', dateStyle: 'short' });

export function daysToDeadline(deadline: string): number {
  return Math.round((Date.parse(`${deadline.slice(0, 10)}T00:00:00+07:00`) -
    Date.parse(`${bangkokDay.format(Date.now())}T00:00:00+07:00`)) / 86_400_000);
}

export function formatDeadline(isoDate: string): string {
  return dateFormat.format(new Date(isoDate));
}

export function JobResultCard({ job, rating, href, compact = false }: {
  job: SearchJobItem;
  rating?: CompanyRating;
  href?: string;
  compact?: boolean;
}) {
  if (compact) {
    return (
      <article className="h-full min-w-0 [overflow-wrap:anywhere]">
        <Link href={href ?? `/jobs/item?id=${job.id}`} className="flex h-full flex-col gap-1.5 rounded-xl border border-border bg-surface-pearl p-4 hover:border-primary focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary">
          <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
            <div className="flex min-w-0 items-center gap-2">
              <Avatar name={job.company.name} src={job.company.logo_url} size="sm" />
              <p className="min-w-0 text-xs text-ink-soft">{job.company.name}</p>
            </div>
            {job.featured && <Badge tone="accent">Featured</Badge>}
          </div>
          <h3 className="text-base font-semibold">{job.job_title}</h3>
          <p className="text-sm text-ink-soft">{allowanceLabel(job.allowance)} · {WORK_MODE_LABEL[job.work_mode]}</p>
          {rating && (
            <p className="mt-auto pt-0.5 text-xs text-ink-soft">
              {rating.review_count > 0
                ? <><span aria-hidden="true" className="mr-1 text-warning-text">★</span>คะแนนบริษัท {rating.rating_avg.toFixed(1)} · {rating.review_count} รีวิว</>
                : 'ยังไม่มีรีวิวบริษัท'}
            </p>
          )}
        </Link>
      </article>
    );
  }

  const category = CATEGORIES.find((entry) => entry.id === job.category)?.label ?? job.category;
  const daysRemaining = daysToDeadline(job.application_deadline);
  return (
    <article className="flex min-w-0 flex-col rounded-xl [overflow-wrap:anywhere] border border-border bg-surface p-5">
      <div className="mb-3 flex items-center gap-3">
        <Avatar name={job.company.name} src={job.company.logo_url} size="sm" />
        <p className="text-sm text-ink-soft">{job.company.name}</p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="neutral">{category}</Badge>
        {job.featured && <Badge tone="accent">Featured</Badge>}
      </div>
      <h2 className="mt-3 text-lg font-semibold">{job.job_title}</h2>
      {job.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5" aria-label="Tag ทักษะ">
          {job.tags.map((tag) => <Badge key={tag.id} tone="neutral">{tag.name}</Badge>)}
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        {job.company.badges.map((badge) => <Badge key={badge} tone="success">{badge}</Badge>)}
      </div>
      <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-sm text-ink-soft">
        <div><dt className="text-xs">ค่าตอบแทน</dt><dd className="text-ink">{allowanceLabel(job.allowance)}</dd></div>
        <div><dt className="text-xs">รูปแบบการทำงาน</dt><dd className="text-ink">{WORK_MODE_LABEL[job.work_mode]} · {job.location}</dd></div>
        <div>
          <dt className="text-xs">คะแนนรีวิว</dt>
          <dd className="text-ink">
            {rating && rating.review_count > 0 ? `${rating.rating_avg.toFixed(1)} (${rating.review_count} รีวิว)` : 'ยังไม่มีรีวิว'}
          </dd>
        </div>
        <div><dt className="text-xs">ปิดรับสมัคร</dt><dd className={daysRemaining >= 0 && daysRemaining <= 7 ? 'font-medium text-warning-text' : 'text-ink'}>{daysRemaining === 0 ? 'วันนี้' : daysRemaining > 0 && daysRemaining <= 7 ? `อีก ${daysRemaining} วัน` : formatDeadline(job.application_deadline)}</dd></div>
      </dl>
      <p className="mt-3 text-xs text-ink-soft">เปิดรับอีก {job.quota_available} จาก {job.quota} ตำแหน่ง</p>
      {job.quota > 0 && <meter className="mt-1 h-2 w-full accent-primary" value={job.quota_available} min={0} max={job.quota} aria-label="ตำแหน่งที่ยังว่าง" />}
      {job.major_mismatch && <p className="mt-3 rounded-lg bg-warning-soft p-3 text-xs text-warning-text">สาขาของคุณต่างจากที่ระบุ ({job.target_majors.join(', ')}) คุณยังส่งใบสมัครได้</p>}
      <Link
        href={href ?? `/jobs/item?id=${job.id}`}
        className="mt-5 inline-block self-start text-sm font-semibold text-primary hover:underline"
      >
        ดูรายละเอียด ›
      </Link>
    </article>
  );
}
