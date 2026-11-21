import type { HrJobObject, JobStatus } from '@internpath/contracts';
import { StatusBadge } from '@/components/ui/status-badge';
import { JOB_STATUS, statusView } from '@/lib/status-map';

const dateFormat = new Intl.DateTimeFormat('th-TH', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Bangkok' });
export const formatDay = (iso: string) => dateFormat.format(new Date(iso));

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const view = statusView(JOB_STATUS, status);
  return <StatusBadge tone={view.tone} icon={view.icon}>{view.label}</StatusBadge>;
}

/** ประกาศที่แก้ได้ในสถานะนี้ (api-contract §5.1 `PATCH`) */
export const EDITABLE_STATUSES: JobStatus[] = ['DRAFT', 'PUBLISHED', 'ADMIN_REJECTED', 'CLOSED'];
export const SUBMITTABLE_STATUSES: JobStatus[] = ['DRAFT', 'ADMIN_REJECTED'];

/** ชื่อประกาศที่แสดงได้เสมอ — `DRAFT` ยังไม่ตั้งชื่อได้ (`null`) */
export const jobTitleOf = (job: HrJobObject): string => job.job_title?.trim() || 'ประกาศที่ยังไม่ตั้งชื่อ';

export const WORK_MODE_LABEL = { ONSITE: 'On-Site', HYBRID: 'Hybrid', REMOTE: 'Remote' } as const;
