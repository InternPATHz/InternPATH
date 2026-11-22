import { AppException } from '@internpath/common';
import type { HrJobDetail, HrJobObject, JobTag } from '@internpath/contracts';
import type { ConfigService } from '@nestjs/config';
import type { CompanySnapshot, Job, Prisma } from '../../../generated/client';
import type { WriteJobDto } from './dto';

export const jobTags = {
  select: { tag: { select: { id: true, name: true, slug: true } } },
  orderBy: [{ tag: { name: 'asc' } }, { tagId: 'asc' }],
} satisfies Prisma.Job$tagsArgs;

export type JobWithTags = Job & { tags: { tag: JobTag }[] };

const toDate = (day?: string) => (day === undefined ? undefined : new Date(day));
const dayOnly = (date: Date | null) => date?.toISOString().slice(0, 10) ?? null;

export function jobFields(body: WriteJobDto) {
  if (body.period && body.period.end <= body.period.start) {
    throw new AppException('VALIDATION_FAILED', 'ช่วงเวลาฝึกงานไม่ถูกต้อง', 400, [
      { field: 'period.end', issue: 'INVALID_PERIOD' },
    ]);
  }
  return {
    category: body.category,
    jobTitle: body.job_title,
    description: body.description,
    responsibilities: body.responsibilities,
    qualifications: body.qualifications,
    allowanceType: body.allowance?.type,
    allowanceAmountThb: body.allowance
      ? body.allowance.type === 'AMOUNT'
        ? (body.allowance.amount_thb ?? null)
        : null
      : undefined,
    allowanceText: body.allowance ? (body.allowance.text ?? null) : undefined,
    location: body.location,
    contactNotes: body.contact_notes,
    workMode: body.work_mode,
    hoursPerWeek: body.hours_per_week,
    internshipPeriodStart: toDate(body.period?.start),
    internshipPeriodEnd: toDate(body.period?.end),
    targetMajors: body.target_majors,
    quota: body.quota,
    applicationDeadline: toDate(body.application_deadline),
  };
}

export function availableQuota(job: Job): number | null {
  return job.quota === null
    ? null
    : job.quota - (job.quotaReserved ?? 0) - (job.quotaConfirmed ?? 0);
}

export function requireFields(job: Job, tagCount?: number): void {
  const required = {
    category: job.category,
    job_title: job.jobTitle?.trim(),
    description: job.description?.trim(),
    responsibilities: job.responsibilities?.trim(),
    qualifications: job.qualifications?.trim(),
    location: job.location?.trim(),
    work_mode: job.workMode,
    hours_per_week: job.hoursPerWeek && job.hoursPerWeek > 0,
    allowance:
      job.allowanceType === 'NONE' ||
      (job.allowanceType === 'AMOUNT' && (job.allowanceAmountThb ?? 0) > 0),
    period: job.internshipPeriodStart && job.internshipPeriodEnd,
    target_majors: job.targetMajors.length > 0,
    tag_ids: tagCount === undefined || (tagCount >= 1 && tagCount <= 10),
    quota: job.quota && job.quota > 0,
    application_deadline: job.applicationDeadline,
  };
  const details = Object.entries(required)
    .filter(([, value]) => !value)
    .map(([field]) => ({ field, issue: 'REQUIRED' }));
  if (details.length) {
    throw new AppException('MISSING_REQUIRED_JOB_FIELDS', 'ข้อมูลบังคับของประกาศยังไม่ครบ', 400, details);
  }
}

export function changeFields(job: Job, next: Job): string[] {
  const fields = {
    job_title: ['jobTitle'],
    description: ['description'],
    responsibilities: ['responsibilities'],
    qualifications: ['qualifications'],
    allowance: ['allowanceType', 'allowanceAmountThb', 'allowanceText'],
    location: ['location'],
    contact_notes: ['contactNotes'],
    work_mode: ['workMode'],
    hours_per_week: ['hoursPerWeek'],
  } as const;
  return Object.entries(fields)
    .filter(([, keys]) => keys.some((key) => job[key] !== next[key]))
    .map(([field]) => field);
}

export function jobPublicAssetBase(config: ConfigService): string | undefined {
  const endpoint = config.get<string>('S3_ENDPOINT');
  const bucket = config.get<string>('S3_BUCKET_PUBLIC');
  return (
    config.get<string>('S3_PUBLIC_BASE_URL') ||
    (endpoint && bucket ? `${endpoint.replace(/\/$/, '')}/${bucket}` : undefined)
  );
}

export function presentJob(
  job: JobWithTags,
  company: CompanySnapshot | null,
  featuredEnabled: boolean,
  publicBase?: string,
): HrJobDetail {
  const badges: string[] = [];
  if (company?.verifiedBadge) badges.push('Verified by Platform');
  if (company?.universityPartner) badges.push('University Partner');
  const logo =
    company?.logoKey && publicBase
      ? `${publicBase.replace(/\/$/, '')}/${company.logoKey.split('/').map(encodeURIComponent).join('/')}`
      : undefined;

  // The jobs_non_draft_complete_check enforces the non-null fields of a published JobObject.
  const result = {
    id: job.id,
    company: {
      id: job.companyId,
      name: company?.name ?? '',
      badges,
      ...(logo ? { logo_url: logo } : {}),
    },
    category: job.category,
    job_title: job.jobTitle,
    description: job.description,
    responsibilities: job.responsibilities,
    qualifications: job.qualifications,
    allowance: job.allowanceType
      ? {
          type: job.allowanceType,
          ...(job.allowanceType === 'AMOUNT' && job.allowanceAmountThb !== null
            ? { amount_thb: job.allowanceAmountThb }
            : {}),
          text: job.allowanceText ?? '',
        }
      : null,
    location: job.location,
    work_mode: job.workMode,
    hours_per_week: job.hoursPerWeek,
    period: { start: dayOnly(job.internshipPeriodStart), end: dayOnly(job.internshipPeriodEnd) },
    target_majors:
      job.status === 'DRAFT' && job.targetMajors.length === 0 ? null : job.targetMajors,
    tags: job.tags.map(({ tag }) => tag),
    quota: job.quota,
    quota_available: availableQuota(job),
    application_deadline: dayOnly(job.applicationDeadline),
    status: job.status,
    featured: job.status === 'PUBLISHED' && job.featured === true && featuredEnabled,
    ...(job.publishedAt ? { published_at: job.publishedAt.toISOString() } : {}),
  } as HrJobObject;
  return {
    ...result,
    ...(job.contactNotes !== null ? { contact_notes: job.contactNotes } : {}),
    ...(job.suspendedFromStatus ? { suspended_from_status: job.suspendedFromStatus } : {}),
    ...(job.status === 'ADMIN_REJECTED' && job.adminReason !== null
      ? { admin_reason: job.adminReason }
      : {}),
  };
}
