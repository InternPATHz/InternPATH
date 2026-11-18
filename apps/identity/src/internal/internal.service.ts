import { Injectable } from '@nestjs/common';
import { AppException, isUuid } from '@internpath/common';
import type { ConsentCheckRequest, ConsentCheckResponse, InternalAdminsResponse, InternalCompanyMembersResponse,
  InternalDenylistResponse, InternalStudentNamesResponse, InternalStudentResponse, UserContact } from '@internpath/contracts';
import { PrismaService } from '../prisma/prisma.service';

/** `?ids=` แบบ Batch: UUID คั่นด้วยจุลภาค 1–100 รายการ (ตัดซ้ำ คงลำดับ) */
function parseBatchIds(ids: unknown): string[] {
  if (typeof ids !== 'string') throw new AppException('VALIDATION_FAILED', 'ต้องระบุ ids', 400);
  const parsed = ids.split(',').map((id) => id.trim());
  if (!parsed.length || parsed.length > 100 || parsed.some((id) => !isUuid(id))) {
    throw new AppException('VALIDATION_FAILED', 'ids ต้องเป็น UUID ไม่เกิน 100 รายการ', 400);
  }
  return [...new Set(parsed)];
}

@Injectable()
export class InternalService {
  constructor(private readonly db: PrismaService) {}

  async contact(userId: string): Promise<UserContact> {
    const user = await this.db.user.findUnique({ where: { id: userId }, select: { id: true, email: true, fullName: true, status: true } });
    if (!user || user.status === 'DELETED') throw new AppException('NOT_FOUND', 'ไม่พบบัญชี', 404);
    return { user_id: user.id, email: user.email, full_name: user.fullName };
  }

  async contacts(ids: string): Promise<UserContact[]> {
    const unique = parseBatchIds(ids);
    const users = await this.db.user.findMany({ where: { id: { in: unique }, status: { not: 'DELETED' } },
      select: { id: true, email: true, fullName: true } });
    const byId = new Map(users.map((user) => [user.id, user]));
    return unique.flatMap((id) => {
      const user = byId.get(id);
      return user ? [{ user_id: user.id, email: user.email, full_name: user.fullName }] : [];
    });
  }

  async student(userId: string): Promise<InternalStudentResponse> {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: { studentProfile: true } });
    if (!user || user.role !== 'STUDENT' || user.status !== 'ACTIVE' || !user.studentProfile || !user.universityId) {
      throw new AppException('NOT_FOUND', 'ไม่พบนักศึกษา', 404);
    }
    return { full_name: user.fullName, major: user.studentProfile.major, year_level: user.studentProfile.yearLevel,
      university_id: user.universityId, email_verified: !!user.emailVerifiedAt,
      ...(user.studentProfile.advisorId ? { advisor_id: user.studentProfile.advisorId } : {}),
      advisor_link_status: user.studentProfile.advisorLinkStatus };
  }

  /** ชื่อนักศึกษาแบบ Batch ให้ Lifecycle (หน้ารายการของอาจารย์/HR) — ไม่มีอีเมล, ข้ามบัญชีที่ลบแล้วและ id ที่ไม่ใช่นักศึกษา */
  async studentNames(ids: string): Promise<InternalStudentNamesResponse> {
    const unique = parseBatchIds(ids);
    const users = await this.db.user.findMany({ where: { id: { in: unique }, role: 'STUDENT', status: { not: 'DELETED' } },
      select: { id: true, fullName: true } });
    const byId = new Map(users.map((user) => [user.id, user.fullName]));
    return unique.flatMap((id) => {
      const fullName = byId.get(id);
      return fullName === undefined ? [] : [{ user_id: id, full_name: fullName }];
    });
  }

  async members(companyId: string): Promise<InternalCompanyMembersResponse> {
    const company = await this.db.company.findUnique({ where: { id: companyId }, select: { id: true } });
    if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
    const members = await this.db.companyMember.findMany({ where: { companyId, user: { status: { not: 'DELETED' } } },
      orderBy: [{ memberRole: 'asc' }, { joinedAt: 'asc' }] });
    return members.map((member) => ({ user_id: member.userId, member_role: member.memberRole }));
  }

  async consent(body: ConsentCheckRequest): Promise<ConsentCheckResponse> {
    const consent = await this.db.consent.findFirst({ where: { userId: body.student_user_id, type: 'RESUME_SHARE',
      targetCompanyId: body.company_id, revokedAt: null, user: { role: 'STUDENT', status: 'ACTIVE' } }, select: { id: true } });
    return { has_consent: !!consent };
  }

  async admins(): Promise<InternalAdminsResponse> {
    const users = await this.db.user.findMany({ where: { role: 'PLATFORM_ADMIN', status: 'ACTIVE', emailVerifiedAt: { not: null } },
      select: { id: true }, orderBy: { id: 'asc' } });
    return users.map((user) => ({ user_id: user.id }));
  }

  async denylist(): Promise<InternalDenylistResponse> {
    const rows = await this.db.tokenDenylist.findMany({ select: { userId: true }, orderBy: { userId: 'asc' } });
    return rows.map((row) => ({ user_id: row.userId }));
  }
}
