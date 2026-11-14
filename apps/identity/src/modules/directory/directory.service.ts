import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@internpath/common';
import type { DirectoryCompanyDetail, DirectoryCompanyListItem } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { DirectoryQueryDto } from './directory.dto';

type DirectoryCompany = Prisma.CompanyGetPayload<{ include: { ratingStats: true } }>;
type DirectoryCompanySummary = DirectoryCompanyListItem & Pick<DirectoryCompanyDetail, 'id'>;

@Injectable()
export class DirectoryService {
  constructor(private readonly db: PrismaService, private readonly config: ConfigService) {}

  private async assertViewer(userId: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: {
      status: true, emailVerifiedAt: true,
    } });
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw new AppException('UNAUTHENTICATED', 'บัญชีนี้ยังใช้งานไม่ได้', 401);
    }
  }

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

  async list(userId: string, query: DirectoryQueryDto): Promise<DirectoryCompanySummary[]> {
    await this.assertViewer(userId);
    if (query.category?.trim()) {
      throw new AppException('VALIDATION_FAILED', 'ยังไม่มีแหล่งข้อมูลหมวดหมู่บริษัทสำหรับตัวกรอง category', 400);
    }
    const q = query.q?.trim();
    const companies = await this.db.company.findMany({
      where: { status: 'VERIFIED',
        ...(q ? { name: { contains: q, mode: 'insensitive' as const } } : {}),
        ...(query.partner === undefined ? {} : { universityPartner: query.partner }),
      },
      include: { ratingStats: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return companies.map((company) => this.summary(company));
  }

  async detail(userId: string, id: string): Promise<DirectoryCompanyDetail> {
    await this.assertViewer(userId);
    const company = await this.db.company.findFirst({
      where: { id, status: 'VERIFIED' }, include: { ratingStats: true },
    });
    if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
    return { ...this.summary(company), ...(company.website ? { website: company.website } : {}) };
  }
}
