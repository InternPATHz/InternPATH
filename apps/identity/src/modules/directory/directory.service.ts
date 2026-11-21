import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@internpath/common';
import type { DirectoryCompanyDetail, DirectoryCompanyListItem, Paginated } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectoryJobClient } from './directory-job.client';
import { DirectoryQueryDto } from './directory.dto';

type DirectoryCompany = Prisma.CompanyGetPayload<{ include: { ratingStats: true } }>;
type DirectoryCompanySummary = DirectoryCompanyListItem & Pick<DirectoryCompanyDetail, 'id'>;

/** api-contract §4.4 — Public: output never depends on the caller. */
@Injectable()
export class DirectoryService {
  constructor(private readonly db: PrismaService, private readonly config: ConfigService, private readonly jobs: DirectoryJobClient) {}

  private logoUrl(key: string): string {
    const publicBase = this.config.get<string>('S3_PUBLIC_BASE_URL');
    const endpoint = this.config.get<string>('S3_ENDPOINT');
    const bucket = this.config.get<string>('S3_BUCKET_PUBLIC');
    const base = publicBase || (endpoint && bucket ? `${endpoint.replace(/\/$/, '')}/${bucket}` : undefined);
    if (!base) throw new AppException('STORAGE_NOT_CONFIGURED', 'Public logo URL is not configured', 503);
    return `${base.replace(/\/$/, '')}/${key.split('/').map(encodeURIComponent).join('/')}`;
  }

  private summary(company: DirectoryCompany): DirectoryCompanySummary {
    const count = company.ratingStats?.reviewCount ?? 0;
    const sum = company.ratingStats?.ratingSum ?? 0;
    return {
      id: company.id,
      name: company.name,
      ...(company.logoKey ? { logo_url: this.logoUrl(company.logoKey) } : {}),
      university_partner: company.universityPartner,
      rating_avg: count > 0 ? sum / count : 0,
      review_count: count,
    };
  }

  async list(query: DirectoryQueryDto): Promise<Paginated<DirectoryCompanySummary>> {
    const categoryIds = query.category ? await this.jobs.companyIds(query.category) : undefined;
    const q = query.q?.trim();
    // Unknown / non-VERIFIED ids simply drop out of the result (no error).
    const ids = query.ids ? [...new Set(query.ids.toLowerCase().split(','))] : undefined;
    const matchingIds = categoryIds ? (ids ? ids.filter((id) => categoryIds.has(id)) : [...categoryIds]) : ids;
    if (matchingIds?.length === 0) return { data: [], meta: { page: query.page, page_size: query.page_size, total: 0 } };
    const where: Prisma.CompanyWhereInput = {
      status: 'VERIFIED',
      ...(matchingIds ? { id: { in: matchingIds } } : {}),
      ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
      ...(query.partner === undefined ? {} : { universityPartner: query.partner }),
    };
    const [total, companies] = await this.db.$transaction([
      this.db.company.count({ where }),
      this.db.company.findMany({
        where, include: { ratingStats: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.page_size, take: query.page_size,
      }),
    ]);
    return {
      data: companies.map((company) => this.summary(company)),
      meta: { page: query.page, page_size: query.page_size, total },
    };
  }

  async detail(id: string): Promise<DirectoryCompanyDetail> {
    const company = await this.db.company.findFirst({
      where: { id, status: 'VERIFIED' }, include: { ratingStats: true },
    });
    if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
    return { ...this.summary(company), ...(company.website ? { website: company.website } : {}) };
  }
}
