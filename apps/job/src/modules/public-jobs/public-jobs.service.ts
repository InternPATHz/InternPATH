import { AppException } from '@internpath/common';
import type { JobObject, JobTag, Paginated, SearchJobItem } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isUUID } from 'class-validator';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { applicationDeadlinePassed, bangkokDate } from '../../status/application-deadline';
import type { SearchJobsQueryDto } from './search-jobs-query.dto';

type PublicJobRow = Omit<
  JobObject,
  'company' | 'allowance' | 'period' | 'status' | 'application_deadline' | 'published_at' | 'tags'
> & {
  status: 'PUBLISHED' | 'CLOSED';
  company_id: string;
  company_name: string;
  logo_key: string | null;
  verified_badge: boolean;
  university_partner: boolean;
  allowance_type: JobObject['allowance']['type'];
  allowance_amount_thb: number | null;
  allowance_text: string | null;
  internship_period_start: Date;
  internship_period_end: Date;
  application_deadline: Date;
  published_at: Date | null;
};

const PUBLIC_COLUMNS = Prisma.sql`
  j.id, j.company_id, c.name AS company_name, c.logo_key, c.verified_badge, c.university_partner,
  j.category, j.job_title, j.description, j.responsibilities, j.qualifications, j.location,
  j.allowance_type, j.allowance_amount_thb, j.allowance_text, j.work_mode, j.hours_per_week,
  j.internship_period_start, j.internship_period_end, j.target_majors, j.quota,
  j.quota - COALESCE(j.quota_reserved, 0) - COALESCE(j.quota_confirmed, 0) AS quota_available,
  j.application_deadline, j.status, j.published_at,
  (j.status = 'PUBLISHED' AND j.featured IS TRUE AND e.featured_enabled IS TRUE) AS featured
`;
const WITH_VERIFIED_COMPANY = Prisma.sql`
  FROM jobs AS j
  JOIN company_snapshots AS c ON c.company_id = j.company_id AND c.status = 'VERIFIED'
`;
const WITH_ENTITLEMENT = Prisma.sql`
  LEFT JOIN company_entitlements AS e ON e.company_id = j.company_id
`;

const normalizeMajor = (value: string) => value.trim().replace(/\s+/g, ' ').toLowerCase();
const dateOnly = (value: Date) => value.toISOString().slice(0, 10);

function majorMismatch(major: string, targetMajors: string[]): boolean {
  const targets = targetMajors.map(normalizeMajor).filter((target) => target.length > 0);
  return targets.length > 0 && !targets.includes(major);
}

@Injectable()
export class PublicJobsService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async search(query: SearchJobsQueryDto): Promise<Paginated<SearchJobItem>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const offset = BigInt(page - 1) * BigInt(pageSize);
    const today = bangkokDate(new Date());
    const filters = [Prisma.sql`j.status = 'PUBLISHED' AND j.application_deadline >= ${today}::date`];
    if (query.category) filters.push(Prisma.sql`j.category = ${query.category}::job_category`);
    if (query.work_mode) filters.push(Prisma.sql`j.work_mode = ${query.work_mode}::work_mode`);
    if (query.company_id) filters.push(Prisma.sql`j.company_id = ${query.company_id}::uuid`);
    if (query.allowance) filters.push(Prisma.sql`j.allowance_type = 'AMOUNT'`);
    if (query.tags) {
      // any-of: ประกาศที่มี Tag ใดก็ได้ในรายการ (Tag ที่ปิดใช้งานแล้วยังกรองได้ — ประกาศเดิมยังติด Tag อยู่)
      const slugs = query.tags.split(',');
      filters.push(Prisma.sql`EXISTS (
        SELECT 1 FROM job_tags AS jt JOIN tags AS t ON t.id = jt.tag_id
        WHERE jt.job_id = j.id AND t.slug IN (${Prisma.join(slugs)})
      )`);
    }
    const q = query.q?.trim();
    if (q) {
      const pattern = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
      // Keep the title match separate so PostgreSQL can use the title trigram index.
      filters.push(Prisma.sql`j.id IN (
        SELECT title_job.id FROM jobs AS title_job
        WHERE title_job.status = 'PUBLISHED' AND title_job.job_title ILIKE ${pattern}
        UNION ALL
        SELECT company_job.id FROM jobs AS company_job
        JOIN company_snapshots AS company ON company.company_id = company_job.company_id
        WHERE company_job.status = 'PUBLISHED' AND company.name ILIKE ${pattern}
      )`);
    }
    const where = Prisma.join(filters, ' AND ');
    const sort =
      query.sort === 'deadline'
        ? Prisma.sql`j.application_deadline ASC`
        : Prisma.sql`j.published_at DESC NULLS LAST`;
    const [rows, [count]] = await this.db.$transaction(
      [
        this.db.$queryRaw<PublicJobRow[]>`
          SELECT ${PUBLIC_COLUMNS}
          ${WITH_VERIFIED_COMPANY} ${WITH_ENTITLEMENT}
          WHERE ${where}
          ORDER BY featured DESC, ${sort}, j.id ASC LIMIT ${pageSize} OFFSET ${offset}
        `,
        this.db.$queryRaw<Array<{ total: bigint }>>`
          SELECT count(*) AS total ${WITH_VERIFIED_COMPANY} WHERE ${where}
        `,
      ],
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
    const major = normalizeMajor(query.major ?? '');
    const tagsByJob = await this.tagsFor(rows.map((row) => row.id));
    const data = rows.map((row): SearchJobItem => ({
      ...this.toJobObject(row, tagsByJob.get(row.id) ?? []),
      ...(major ? { major_mismatch: majorMismatch(major, row.target_majors) } : {}),
    }));
    return { data, meta: { page, page_size: pageSize, total: Number(count.total) } };
  }

  async detail(id: string): Promise<JobObject> {
    const now = new Date();
    if (isUUID(id, '4')) {
      const [row] = await this.db.$queryRaw<PublicJobRow[]>`
        SELECT ${PUBLIC_COLUMNS}
        ${WITH_VERIFIED_COMPANY} ${WITH_ENTITLEMENT}
        WHERE j.id = ${id}::uuid AND j.status IN ('PUBLISHED', 'CLOSED')
      `;
      if (row) {
        const job = this.toJobObject(row, (await this.tagsFor([row.id])).get(row.id) ?? []);
        if (job.status === 'PUBLISHED' && applicationDeadlinePassed(row.application_deadline, now)) {
          return { ...job, status: 'CLOSED', featured: false };
        }
        return job;
      }
    }
    throw new AppException('NOT_FOUND', 'ไม่พบประกาศงาน', 404);
  }

  private async tagsFor(jobIds: string[]): Promise<Map<string, JobTag[]>> {
    const map = new Map<string, JobTag[]>();
    if (jobIds.length === 0) return map;
    const rows = await this.db.jobTag.findMany({
      where: { jobId: { in: jobIds } },
      select: { jobId: true, tag: { select: { id: true, name: true, slug: true } } },
      orderBy: { tag: { name: 'asc' } },
    });
    for (const row of rows) map.set(row.jobId, [...(map.get(row.jobId) ?? []), row.tag]);
    return map;
  }

  private logoUrl(key: string | null): string | undefined {
    if (!key) return;
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const bucket = this.config.get<string>('S3_BUCKET_PUBLIC');
    const base =
      this.config.get<string>('S3_PUBLIC_BASE_URL') ||
      (endpoint && bucket ? `${endpoint.replace(/\/$/, '')}/${bucket}` : undefined);
    if (base)
      return `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private toJobObject(row: PublicJobRow, tags: JobTag[]): JobObject {
    const badges: string[] = [];
    if (row.verified_badge) badges.push('Verified by Platform');
    if (row.university_partner) badges.push('University Partner');
    const logoUrl = this.logoUrl(row.logo_key);
    return {
      id: row.id,
      company: {
        id: row.company_id,
        name: row.company_name,
        badges,
        ...(logoUrl ? { logo_url: logoUrl } : {}),
      },
      category: row.category,
      job_title: row.job_title,
      description: row.description,
      responsibilities: row.responsibilities,
      qualifications: row.qualifications,
      allowance: {
        type: row.allowance_type,
        ...(row.allowance_type === 'AMOUNT' && row.allowance_amount_thb !== null
          ? { amount_thb: row.allowance_amount_thb }
          : {}),
        text: row.allowance_text ?? '',
      },
      location: row.location,
      work_mode: row.work_mode,
      hours_per_week: row.hours_per_week,
      period: {
        start: dateOnly(row.internship_period_start),
        end: dateOnly(row.internship_period_end),
      },
      target_majors: row.target_majors,
      tags,
      quota: row.quota,
      quota_available: row.quota_available,
      application_deadline: dateOnly(row.application_deadline),
      status: row.status,
      featured: row.featured,
      ...(row.published_at ? { published_at: row.published_at.toISOString() } : {}),
    };
  }
}
