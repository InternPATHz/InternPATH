import { Injectable } from '@nestjs/common';
import { AppException } from '@internpath/common';
import type { UserMeResponse } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { UpdateMeDto } from './users.dto';

const profile = { studentProfile: true, advisorProfile: true, companyMember: { include: { company: true } } } as const;
type ProfileUser = Prisma.UserGetPayload<{ include: typeof profile }>;

@Injectable()
export class UsersService {
  constructor(private readonly db: PrismaService) {}

  private async active(userId: string): Promise<ProfileUser> {
    const user = await this.db.user.findUnique({ where: { id: userId }, include: profile });
    if (!user || user.status === 'DELETED') throw new AppException('UNAUTHENTICATED', 'ไม่พบบัญชีที่ใช้งานได้', 401);
    if (user.status !== 'ACTIVE') throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ยังใช้งานไม่ได้', 401);
    if (!user.emailVerifiedAt) throw new AppException('EMAIL_NOT_VERIFIED', 'ต้องยืนยันอีเมลก่อน', 401);
    return user;
  }

  private response(user: ProfileUser): UserMeResponse {
    return { id: user.id, email: user.email, full_name: user.fullName,
      ...(user.phone ? { phone: user.phone } : {}), role: user.role, status: user.status,
      email_verified: !!user.emailVerifiedAt, created_at: user.createdAt.toISOString(),
      ...(user.role === 'STUDENT' && user.studentProfile ? { student: {
        student_code: user.studentProfile.studentCode, major: user.studentProfile.major,
        year_level: user.studentProfile.yearLevel, advisor_link_status: user.studentProfile.advisorLinkStatus,
        ...(user.studentProfile.advisorId ? { advisor_id: user.studentProfile.advisorId } : {}),
      } } : {}),
      ...(user.role === 'ADVISOR' && user.advisorProfile ? { advisor: {
        ...(user.advisorProfile.department ? { department: user.advisorProfile.department } : {}),
      } } : {}),
      ...(user.role === 'COMPANY_HR' && user.companyMember ? { company: {
        id: user.companyMember.companyId, name: user.companyMember.company.name,
        status: user.companyMember.company.status, member_role: user.companyMember.memberRole,
        // สายงานที่ Owner มอบหมาย — ฟอร์มประกาศของ Member แสดงเฉพาะสายงานเหล่านี้ (Owner ดูแลทุกสายงาน จึงไม่ส่ง)
        ...(user.companyMember.memberRole === 'MEMBER' ? { categories: user.companyMember.categories } : {}),
      } } : {}),
    };
  }

  async me(userId: string): Promise<UserMeResponse> { return this.response(await this.active(userId)); }

  async update(userId: string, body: UpdateMeDto): Promise<UserMeResponse> {
    const user = await this.active(userId);
    const fullName = body.full_name === undefined ? user.fullName : body.full_name.trim();
    if (!fullName) throw new AppException('VALIDATION_FAILED', 'ต้องระบุชื่อ', 400);
    const phone = body.phone === undefined ? user.phone : body.phone.trim() || null;
    if (fullName === user.fullName && phone === user.phone) return this.response(user);
    const changed = await this.db.user.updateMany({ where: { id: userId, version: user.version, status: 'ACTIVE' },
      data: { fullName, phone, version: { increment: 1 } } });
    if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลผู้ใช้ถูกเปลี่ยนแล้ว', 409);
    return this.me(userId);
  }
}
