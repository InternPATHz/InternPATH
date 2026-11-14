import { Injectable } from '@nestjs/common';
import { AppException } from '@internpath/common';
import { PrismaService } from '../../prisma/prisma.service';
import { RecordConsentDto } from './consents.dto';

@Injectable()
export class ConsentsService {
  constructor(private readonly db: PrismaService) {}

  async record(userId: string, body: RecordConsentDto): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: {
      role: true, status: true, emailVerifiedAt: true,
    } });
    if (!user || user.role !== 'STUDENT') throw new AppException('FORBIDDEN_ROLE', 'เฉพาะนักศึกษาเท่านั้น', 403);
    if (user.status !== 'ACTIVE') throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ยังใช้งานไม่ได้', 401);
    if (!user.emailVerifiedAt) throw new AppException('EMAIL_NOT_VERIFIED', 'ต้องยืนยันอีเมลก่อน', 401);
    const company = await this.db.company.findUnique({ where: { id: body.target_company_id }, select: { id: true } });
    if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
    await this.db.consent.create({ data: { userId, type: body.type, policyVersion: 'v1',
      targetCompanyId: company.id, ...(body.application_id ? { applicationId: body.application_id } : {}) } });
  }
}
