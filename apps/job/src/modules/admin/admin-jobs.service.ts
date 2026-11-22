import type { AdminJobItem, AdminJobsQuery, Paginated } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { jobPublicAssetBase, jobTags, presentJob } from '../hr-jobs/hr-job-fields';

@Injectable()
export class AdminJobsService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async list(query: AdminJobsQuery): Promise<Paginated<AdminJobItem>> {
    const page = query.page ?? 1;
    const pageSize = query.page_size ?? 20;
    const skip = (page - 1) * pageSize;
    const term = query.q?.replace(/[\\%_]/g, '\\$&');
    const textFilter = term ? { contains: term, mode: 'insensitive' as const } : undefined;
    const where: Prisma.JobWhereInput = {
      status: query.status,
      companyId: query.company_id,
      ...(textFilter ? { OR: [{ jobTitle: textFilter }, { description: textFilter }] } : {}),
    };
    const publicBase = jobPublicAssetBase(this.config);

    return this.db.$transaction(
      async (tx) => {
        const total = await tx.job.count({ where });
        const meta = { page, page_size: pageSize, total };
        if (skip >= total) return { data: [], meta };

        const jobs = await tx.job.findMany({
          where,
          orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
          skip,
          take: pageSize,
          include: {
            tags: jobTags,
            // Only E04 creates an ACTIVE round, with the queue ID issued by Verification.
            reportRounds: { where: { status: 'ACTIVE' }, select: { queueItemId: true } },
          },
        });
        const companyIds = [...new Set(jobs.map((job) => job.companyId))];
        const [companies, entitlements] = await Promise.all([
          tx.companySnapshot.findMany({ where: { companyId: { in: companyIds } } }),
          tx.companyEntitlement.findMany({ where: { companyId: { in: companyIds } } }),
        ]);
        const snapshots = new Map(companies.map((company) => [company.companyId, company]));
        const featured = new Map(
          entitlements.map((entry) => [entry.companyId, entry.featuredEnabled]),
        );

        const data = jobs.map((job): AdminJobItem => {
          const reportQueueItemId = job.reportRounds[0]?.queueItemId;
          return {
            ...presentJob(
              job,
              snapshots.get(job.companyId) ?? null,
              featured.get(job.companyId) ?? false,
              publicBase,
            ),
            created_at: job.createdAt.toISOString(),
            ...(reportQueueItemId ? { report_queue_item_id: reportQueueItemId } : {}),
          };
        });
        return { data, meta };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }
}
