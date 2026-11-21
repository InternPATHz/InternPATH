import type { DirectoryCompanyIdsResponse, JobCategory } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';

export const DIRECTORY_COMPANY_IDS_PAGE_SIZE = 1000;

@Injectable()
export class DirectoryCompanyIdsService {
  constructor(private readonly db: PrismaService) {}

  async list(category: JobCategory, after?: string): Promise<DirectoryCompanyIdsResponse> {
    const rows = await this.db.$queryRaw<Array<{ company_id: string }>>`
      SELECT DISTINCT company_id FROM jobs
      WHERE status = 'PUBLISHED' AND category = ${category}::job_category
        ${after ? Prisma.sql`AND company_id > ${after}::uuid` : Prisma.empty}
      ORDER BY company_id ASC LIMIT ${DIRECTORY_COMPANY_IDS_PAGE_SIZE + 1}
    `;
    const hasMore = rows.length > DIRECTORY_COMPANY_IDS_PAGE_SIZE;
    const ids = rows.slice(0, DIRECTORY_COMPANY_IDS_PAGE_SIZE).map((row) => row.company_id);
    return { company_ids: ids, next_cursor: hasMore ? ids.at(-1)! : null };
  }
}
