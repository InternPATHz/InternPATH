import { Injectable } from '@nestjs/common';
import { AppException, OutboxWriter, asUuid } from '@internpath/common';
import type { CompanyEntitlementChangedPayload, CompanyStatusChangedPayload, UserSuspendedPayload } from '@internpath/contracts';
import { Company, Prisma, User } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminUsersQueryDto, AuditQueryDto, SetEntitlementsDto } from './admin.dto';

@Injectable()
export class AdminService {
  constructor(private readonly db: PrismaService, private readonly outbox: OutboxWriter) {}

  private async admin(id: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user || user.role !== 'PLATFORM_ADMIN') throw new AppException('FORBIDDEN_ROLE', 'เฉพาะ Admin เท่านั้น', 403);
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) throw new AppException('ACCOUNT_SUSPENDED', 'บัญชี Admin ยังใช้งานไม่ได้', 403);
  }

  private async company(tx: Prisma.TransactionClient, id: string): Promise<Company> {
    const company = await tx.company.findUnique({ where: { id } });
    if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
    return company;
  }

  private async auditChange(tx: Prisma.TransactionClient, adminId: string, action: string, targetType: string,
    targetId: string, before: Prisma.InputJsonValue, after: Prisma.InputJsonValue, cid: string, reason?: string): Promise<void> {
    await tx.adminAuditLog.create({ data: { adminId, action, targetType, targetId, before, after,
      reason: reason ?? null, correlationId: cid, occurredAt: new Date() } });
  }

  async partner(adminId: string, companyId: string, enabled: boolean, correlationId?: string): Promise<{ enabled: boolean }> {
    await this.admin(adminId);
    const cid = asUuid(correlationId);
    return this.db.$transaction(async (tx) => {
      const before = await this.company(tx, companyId);
      if (before.universityPartner === enabled) return { enabled };
      const changed = await tx.company.updateMany({ where: { id: companyId, version: before.version,
        universityPartner: before.universityPartner }, data: { universityPartner: enabled, version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลบริษัทถูกเปลี่ยนแล้ว', 409);
      const current = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      const owner = await tx.companyMember.findFirst({ where: { companyId, memberRole: 'OWNER' } });
      const payload: CompanyStatusChangedPayload = {
        company_id: companyId, status: current.status, previous_status: before.status,
        snapshot: { name: current.name, ...(current.logoKey ? { logo_key: current.logoKey } : {}),
          university_partner: enabled, verified_badge: current.status === 'VERIFIED' },
        ...(owner ? { owner_user_id: owner.userId } : {}), entity_version: current.version, changed_at: new Date().toISOString(),
      };
      await this.outbox.add(tx, { type: 'CompanyStatusChanged', aggregateId: companyId, correlationId: cid, payload });
      await this.auditChange(tx, adminId, 'COMPANY_UNIVERSITY_PARTNER', 'COMPANY', companyId,
        { enabled: before.universityPartner }, { enabled }, cid);
      return { enabled };
    });
  }

  async entitlements(adminId: string, companyId: string, input: SetEntitlementsDto, correlationId?: string):
    Promise<{ featured_enabled: boolean; fast_track_enabled: boolean }> {
    await this.admin(adminId);
    const cid = asUuid(correlationId);
    return this.db.$transaction(async (tx) => {
      const before = await this.company(tx, companyId);
      const { featured_enabled, fast_track_enabled } = input;
      if (before.featuredEnabled === featured_enabled && before.fastTrackEnabled === fast_track_enabled) {
        return { featured_enabled, fast_track_enabled };
      }
      const changed = await tx.company.updateMany({ where: { id: companyId, version: before.version,
        featuredEnabled: before.featuredEnabled, fastTrackEnabled: before.fastTrackEnabled },
      data: { featuredEnabled: featured_enabled, fastTrackEnabled: fast_track_enabled, version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลบริษัทถูกเปลี่ยนแล้ว', 409);
      const current = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      const payload: CompanyEntitlementChangedPayload = { company_id: companyId, featured_enabled, fast_track_enabled,
        entity_version: current.version, changed_at: new Date().toISOString() };
      await this.outbox.add(tx, { type: 'CompanyEntitlementChanged', aggregateId: companyId, correlationId: cid, payload });
      await this.auditChange(tx, adminId, 'COMPANY_ENTITLEMENTS', 'COMPANY', companyId,
        { featured_enabled: before.featuredEnabled, fast_track_enabled: before.fastTrackEnabled },
        { featured_enabled, fast_track_enabled }, cid);
      return { featured_enabled, fast_track_enabled };
    });
  }

  async userAction(adminId: string, userId: string, action: string, reason?: string, correlationId?: string): Promise<void> {
    await this.admin(adminId);
    if (action !== 'suspend' && action !== 'unsuspend') throw new AppException('NOT_FOUND', 'ไม่พบ action นี้', 404);
    const note = reason?.trim();
    if (action === 'suspend' && !note) throw new AppException('REASON_REQUIRED', 'ต้องระบุเหตุผล', 400);
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id: userId }, include: { companyMember: { include: { company: true } } } });
      if (!before) throw new AppException('NOT_FOUND', 'ไม่พบบัญชี', 404);
      const expected = action === 'suspend' ? 'ACTIVE' : 'SUSPENDED';
      const status = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      if (before.status !== expected) throw new AppException('STATE_CONFLICT', 'สถานะบัญชีไม่รองรับการดำเนินการนี้', 409);
      if (action === 'unsuspend' && before.companyMember?.company.status === 'SUSPENDED') {
        throw new AppException('STATE_CONFLICT', 'บริษัทยังถูกระงับอยู่', 409);
      }
      const updated = await tx.user.updateMany({ where: { id: userId, status: expected, version: before.version },
        data: { status, suspendedReason: action === 'suspend' ? note : null, version: { increment: 1 } } });
      if (updated.count !== 1) throw new AppException('STATE_CONFLICT', 'สถานะบัญชีถูกเปลี่ยนแล้ว', 409);
      const current: User = await tx.user.findUniqueOrThrow({ where: { id: userId } });
      if (action === 'suspend') await tx.tokenDenylist.upsert({ where: { userId }, create: { userId, reason: note! }, update: { reason: note! } });
      else await tx.tokenDenylist.deleteMany({ where: { userId } });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: userId, fromStatus: before.status, toStatus: status,
        actorId: adminId, actorRole: 'PLATFORM_ADMIN', reason: note ?? before.suspendedReason, correlationId: cid, occurredAt: new Date() } });
      const payload: UserSuspendedPayload = { user_id: userId, suspended: action === 'suspend',
        ...(action === 'suspend' ? { reason: note } : {}), entity_version: current.version, at: new Date().toISOString() };
      await this.outbox.add(tx, { type: 'UserSuspended', aggregateId: userId, correlationId: cid, payload });
      await this.auditChange(tx, adminId, `USER_${action.toUpperCase()}`, 'USER', userId,
        { status: before.status }, { status: current.status }, cid, note ?? before.suspendedReason ?? undefined);
    });
  }

  async audit(adminId: string, query: AuditQueryDto) {
    await this.admin(adminId);
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}), ...(query.target_type ? { targetType: query.target_type } : {}),
      ...(query.target_id ? { targetId: query.target_id } : {}), ...(query.admin_id ? { adminId: query.admin_id } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.adminAuditLog.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.adminAuditLog.count({ where }),
    ]);
    return { data: rows.map((row) => ({ id: row.id, admin_id: row.adminId, action: row.action, target_type: row.targetType,
      target_id: row.targetId, before: row.before, after: row.after, reason: row.reason,
      correlation_id: row.correlationId, occurred_at: row.occurredAt.toISOString() })),
    meta: { page: query.page, page_size: query.page_size, total } };
  }

  async users(adminId: string, query: AdminUsersQueryDto) {
    await this.admin(adminId);
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : { status: { not: 'DELETED' } }),
      ...(q ? { OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { studentProfile: { is: { studentCode: { contains: q, mode: 'insensitive' } } } },
      ] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.user.findMany({ where, include: { studentProfile: true, companyMember: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.user.count({ where }),
    ]);
    return { data: rows.map((user) => ({ id: user.id, full_name: user.fullName, email: user.email,
      role: user.role, status: user.status, university_id: user.universityId,
      advisor_id: user.studentProfile?.advisorId ?? null, student_code: user.studentProfile?.studentCode ?? null,
      company_id: user.companyMember?.companyId ?? null, created_at: user.createdAt.toISOString() })),
    meta: { page: query.page, page_size: query.page_size, total } };
  }
}
