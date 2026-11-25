import Link from 'next/link';
import type { SearchJobItem, WorkMode } from '@internpath/contracts';
import { allowanceLabel } from '@/lib/allowance';
import { Avatar } from '@/components/ui/avatar';
import { CATEGORIES } from '@/lib/categories';
import type { CompanyRating } from '@/lib/job-search';

const workModeLabel: Record<WorkMode, string> = { ONSITE: 'On-Site', HYBRID: 'Hybrid', REMOTE: 'Remote' };

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

export function formatDeadline(isoDate: string): string {
  return dateFormat.format(new Date(isoDate));
}

export function JobResultCard({ job, rating, href }: { job: SearchJobItem; rating?: CompanyRating; href?: string }) {
  const category = CATEGORIES.find((entry) => entry.id === job.category)?.label ?? job.category;
  const daysRemaining = Math.round((Date.parse(`${job.application_deadline.slice(0, 10)}T00:00:00+07:00`) -
    Date.parse(`${bangkokDay.format(Date.now())}T00:00:00+07:00`)) / 86_400_000);
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
        <div><dt className="text-xs">รูปแบบการทำงาน</dt><dd className="text-ink">{workModeLabel[job.work_mode]} · {job.location}</dd></div>
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
