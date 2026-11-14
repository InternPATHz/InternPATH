import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppException, OutboxWriter } from '@internpath/common';
import type { AdminAdvisorListItem, AdvisorLinkChangedPayload, AdvisorLinkRequestItem, AdvisorListItem, LinkedStudentItem, UserMeResponse } from '@internpath/contracts';
import { Prisma, StudentProfileIdentity, User } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminAdvisorQueryDto, AdvisorSearchDto } from './advisor-link.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const asUuid = (value?: string): string => value && UUID.test(value) ? value : randomUUID();
type Page<T> = { data: T[]; meta: { page: number; page_size: number; total: number } };

function page<T>(data: T[], total: number, query: { page: number; page_size: number }): Page<T> {
  return { data, meta: { page: query.page, page_size: query.page_size, total } };
}

@Injectable()
export class AdvisorLinkService {
  constructor(private readonly db: PrismaService, private readonly outbox: OutboxWriter) {}

  private async actor(id: string, role?: User['role']): Promise<User> {
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user || (role && user.role !== role)) throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์ดำเนินการ', 403);
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ยังใช้งานไม่ได้', 403);
    return user;
  }

  private async targetAdvisor(tx: Prisma.TransactionClient, advisorId: string, universityId: string | null): Promise<User> {
    const advisor = await tx.user.findUnique({ where: { id: advisorId } });
    if (!advisor || advisor.role !== 'ADVISOR') throw new AppException('NOT_FOUND', 'ไม่พบอาจารย์ที่ปรึกษา', 404);
    if (advisor.status !== 'ACTIVE' || !advisor.emailVerifiedAt) throw new AppException('STATE_CONFLICT', 'อาจารย์ยังไม่พร้อมรับคำขอ', 409);
    if (!universityId || advisor.universityId !== universityId) throw new AppException('FORBIDDEN_ROLE', 'อาจารย์ต้องอยู่สถาบันเดียวกัน', 403);
    return advisor;
  }

  async me(id: string): Promise<UserMeResponse> {
    await this.actor(id);
    const user = await this.db.user.findUniqueOrThrow({ where: { id }, include: {
      studentProfile: true, advisorProfile: true, companyMember: { include: { company: true } },
    } });
    return {
      id: user.id, email: user.email, full_name: user.fullName,
      ...(user.phone ? { phone: user.phone } : {}), role: user.role, status: user.status,
      email_verified: !!user.emailVerifiedAt, created_at: user.createdAt.toISOString(),
      ...(user.studentProfile ? { student: {
        student_code: user.studentProfile.studentCode, major: user.studentProfile.major,
        year_level: user.studentProfile.yearLevel, advisor_link_status: user.studentProfile.advisorLinkStatus,
        ...(user.studentProfile.advisorId ? { advisor_id: user.studentProfile.advisorId } : {}),
        ...(user.studentProfile.pendingAdvisorId ? { pending_advisor_id: user.studentProfile.pendingAdvisorId } : {}),
      } } : {}),
      ...(user.advisorProfile ? { advisor: { department: user.advisorProfile.department } } : {}),
      ...(user.companyMember ? { company: {
        id: user.companyMember.companyId, name: user.companyMember.company.name,
        status: user.companyMember.company.status, member_role: user.companyMember.memberRole,
      } } : {}),
    };
  }

  async advisors(studentId: string, query: AdvisorSearchDto): Promise<Page<AdvisorListItem>> {
    const student = await this.actor(studentId, 'STUDENT');
    const q = query.q?.trim();
    const where: Prisma.UserWhereInput = {
      role: 'ADVISOR', status: 'ACTIVE', universityId: student.universityId, emailVerifiedAt: { not: null },
      ...(q ? { OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { advisorProfile: { is: { department: { contains: q, mode: 'insensitive' } } } },
      ] } : {}),
    };
    const [users, total] = await Promise.all([
      this.db.user.findMany({ where, include: { advisorProfile: true }, orderBy: { fullName: 'asc' }, skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.user.count({ where }),
    ]);
    return page(users.map((user) => ({ id: user.id, full_name: user.fullName, ...(user.advisorProfile?.department ? { department: user.advisorProfile.department } : {}) })), total, query);
  }

  private async linkEvent(tx: Prisma.TransactionClient, args: {
    studentId: string; before: StudentProfileIdentity; toStatus: StudentProfileIdentity['advisorLinkStatus'];
    newAdvisorId?: string; changedBy: AdvisorLinkChangedPayload['changed_by']; actorId: string; correlationId: string; now: Date;
  }): Promise<void> {
    const student = await tx.user.update({ where: { id: args.studentId }, data: { version: { increment: 1 } } });
    const eventStatus: AdvisorLinkChangedPayload['link_status'] = args.toStatus === 'NONE' ? 'UNLINKED' : args.toStatus;
    const payload: AdvisorLinkChangedPayload = {
      student_user_id: args.studentId,
      ...(args.before.advisorId ? { old_advisor_id: args.before.advisorId } : {}),
      ...(args.newAdvisorId ? { new_advisor_id: args.newAdvisorId } : {}),
      link_status: eventStatus, changed_by: args.changedBy,
      entity_version: student.version, changed_at: args.now.toISOString(),
    };
    await tx.statusHistory.create({ data: {
      entity: 'USER', entityId: args.studentId, fromStatus: args.before.advisorLinkStatus,
      toStatus: args.toStatus, actorId: args.actorId,
      actorRole: args.changedBy === 'ADMIN' ? 'PLATFORM_ADMIN' : args.changedBy,
      reason: 'ADVISOR_LINK', correlationId: args.correlationId, occurredAt: args.now,
    } });
    await this.outbox.add(tx, { type: 'AdvisorLinkChanged', aggregateId: args.studentId, correlationId: args.correlationId, payload });
  }

  async request(studentId: string, advisorId: string, correlationId: string): Promise<void> {
    const student = await this.actor(studentId, 'STUDENT');
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      await this.targetAdvisor(tx, advisorId, student.universityId);
      const profile = await tx.studentProfileIdentity.findUnique({ where: { userId: studentId } });
      if (!profile) throw new AppException('NOT_FOUND', 'ไม่พบข้อมูลนักศึกษา', 404);
      if (profile.advisorLinkStatus === 'ADVISOR_LINK_PENDING' || profile.advisorId === advisorId) {
        throw new AppException('STATE_CONFLICT', 'มีคำขอค้างอยู่หรือผูกอาจารย์คนนี้แล้ว', 409);
      }
      const now = new Date();
      const changed = await tx.studentProfileIdentity.updateMany({
        where: { userId: studentId, advisorLinkStatus: profile.advisorLinkStatus, advisorId: profile.advisorId, pendingAdvisorId: null },
        data: { advisorLinkStatus: 'ADVISOR_LINK_PENDING', pendingAdvisorId: advisorId, advisorLinkUpdatedAt: now },
      });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'คำขอถูกเปลี่ยนไปแล้ว', 409);
      await this.linkEvent(tx, { studentId, before: profile, toStatus: 'ADVISOR_LINK_PENDING', newAdvisorId: advisorId, changedBy: 'STUDENT', actorId: studentId, correlationId: cid, now });
    });
  }

  private async clearPending(studentId: string, expectedAdvisorId: string | undefined, changedBy: AdvisorLinkChangedPayload['changed_by'], actorId: string, correlationId: string): Promise<void> {
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const profile = await tx.studentProfileIdentity.findUnique({ where: { userId: studentId } });
      if (!profile || profile.advisorLinkStatus !== 'ADVISOR_LINK_PENDING' || !profile.pendingAdvisorId ||
          (expectedAdvisorId && profile.pendingAdvisorId !== expectedAdvisorId)) {
        throw new AppException('STATE_CONFLICT', 'ไม่พบคำขอที่รอดำเนินการ', 409);
      }
      const toStatus = profile.advisorId ? 'LINKED' : 'NONE';
      const now = new Date();
      const changed = await tx.studentProfileIdentity.updateMany({
        where: { userId: studentId, advisorLinkStatus: 'ADVISOR_LINK_PENDING', pendingAdvisorId: profile.pendingAdvisorId, advisorId: profile.advisorId },
        data: { advisorLinkStatus: toStatus, pendingAdvisorId: null, advisorLinkUpdatedAt: now },
      });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'คำขอถูกเปลี่ยนไปแล้ว', 409);
      await this.linkEvent(tx, { studentId, before: profile, toStatus, newAdvisorId: profile.advisorId ?? undefined, changedBy, actorId, correlationId: cid, now });
    });
  }

  async cancel(studentId: string, correlationId: string): Promise<void> {
    await this.actor(studentId, 'STUDENT');
    return this.clearPending(studentId, undefined, 'STUDENT', studentId, correlationId);
  }

  async requests(advisorId: string, query: AdvisorSearchDto): Promise<Page<AdvisorLinkRequestItem>> {
    await this.actor(advisorId, 'ADVISOR');
    const where: Prisma.StudentProfileIdentityWhereInput = { pendingAdvisorId: advisorId, advisorLinkStatus: 'ADVISOR_LINK_PENDING' };
    const [profiles, total] = await Promise.all([
      this.db.studentProfileIdentity.findMany({ where, include: { user: true }, orderBy: { advisorLinkUpdatedAt: 'desc' }, skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.studentProfileIdentity.count({ where }),
    ]);
    return page(profiles.map((profile) => ({
      student_user_id: profile.userId, full_name: profile.user.fullName, student_code: profile.studentCode,
      major: profile.major, year_level: profile.yearLevel, requested_at: (profile.advisorLinkUpdatedAt ?? profile.updatedAt).toISOString(),
    })), total, query);
  }

  async students(advisorId: string, query: AdvisorSearchDto): Promise<Page<LinkedStudentItem>> {
    await this.actor(advisorId, 'ADVISOR');
    const where: Prisma.StudentProfileIdentityWhereInput = { advisorId };
    const [profiles, total] = await Promise.all([
      this.db.studentProfileIdentity.findMany({ where, include: { user: true }, orderBy: { createdAt: 'asc' }, skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.studentProfileIdentity.count({ where }),
    ]);
    return page(profiles.map((profile) => ({ student_user_id: profile.userId, full_name: profile.user.fullName, student_code: profile.studentCode, major: profile.major, year_level: profile.yearLevel })), total, query);
  }

  async action(advisorId: string, studentId: string, action: string, correlationId: string): Promise<void> {
    const advisor = await this.actor(advisorId, 'ADVISOR');
    if (action !== 'confirm' && action !== 'reject') throw new AppException('NOT_FOUND', 'ไม่พบ action นี้', 404);
    if (action === 'reject') return this.clearPending(studentId, advisorId, 'ADVISOR', advisorId, correlationId);
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const profile = await tx.studentProfileIdentity.findUnique({ where: { userId: studentId }, include: { user: true } });
      if (!profile || profile.advisorLinkStatus !== 'ADVISOR_LINK_PENDING' || profile.pendingAdvisorId !== advisorId) throw new AppException('STATE_CONFLICT', 'ไม่พบคำขอที่รอยืนยัน', 409);
      if (profile.user.status !== 'ACTIVE' || profile.user.universityId !== advisor.universityId) throw new AppException('STATE_CONFLICT', 'นักศึกษาไม่พร้อมผูกอาจารย์', 409);
      const now = new Date();
      const changed = await tx.studentProfileIdentity.updateMany({
        where: { userId: studentId, advisorLinkStatus: 'ADVISOR_LINK_PENDING', pendingAdvisorId: advisorId, advisorId: profile.advisorId },
        data: { advisorLinkStatus: 'LINKED', advisorId, pendingAdvisorId: null, advisorLinkUpdatedAt: now },
      });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'คำขอถูกเปลี่ยนไปแล้ว', 409);
      await this.linkEvent(tx, { studentId, before: profile, toStatus: 'LINKED', newAdvisorId: advisorId, changedBy: 'ADVISOR', actorId: advisorId, correlationId: cid, now });
    });
  }

  async adminAdvisors(adminId: string, query: AdminAdvisorQueryDto): Promise<Page<AdminAdvisorListItem>> {
    await this.actor(adminId, 'PLATFORM_ADMIN');
    const where: Prisma.UserWhereInput = { role: 'ADVISOR', ...(query.status ? { status: query.status } : {}) };
    const [users, total] = await Promise.all([
      this.db.user.findMany({ where, include: { advisorProfile: true }, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.user.count({ where }),
    ]);
    return page(users.map((user) => ({ id: user.id, full_name: user.fullName, email: user.email,
      ...(user.advisorProfile?.department ? { department: user.advisorProfile.department } : {}), status: user.status, created_at: user.createdAt.toISOString() })), total, query);
  }

  async adminAdvisorAction(adminId: string, advisorId: string, action: string, reason: string | undefined, correlationId: string): Promise<void> {
    await this.actor(adminId, 'PLATFORM_ADMIN');
    if (action !== 'approve' && action !== 'reject') throw new AppException('NOT_FOUND', 'ไม่พบ action นี้', 404);
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const advisor = await tx.user.findUnique({ where: { id: advisorId }, include: { advisorProfile: true } });
      if (!advisor || advisor.role !== 'ADVISOR') throw new AppException('NOT_FOUND', 'ไม่พบอาจารย์', 404);
      if (advisor.status !== 'PENDING_APPROVAL' || !advisor.emailVerifiedAt) throw new AppException('STATE_CONFLICT', 'บัญชีนี้ไม่ได้รออนุมัติ', 409);
      const now = new Date();
      const status = action === 'approve' ? 'ACTIVE' : 'SUSPENDED';
      const rejectionReason = action === 'reject' ? (reason?.trim() || 'ADVISOR_REGISTRATION_REJECTED') : null;
      const updated = await tx.user.updateMany({ where: { id: advisorId, status: 'PENDING_APPROVAL' }, data: {
        status, suspendedReason: rejectionReason, version: { increment: 1 },
      } });
      if (updated.count !== 1) throw new AppException('STATE_CONFLICT', 'บัญชีถูกเปลี่ยนไปแล้ว', 409);
      const current = await tx.user.findUniqueOrThrow({ where: { id: advisorId } });
      if (action === 'approve') {
        await tx.advisorProfile.update({ where: { userId: advisorId }, data: { approvedBy: adminId, approvedAt: now } });
      } else {
        await tx.tokenDenylist.upsert({ where: { userId: advisorId }, create: { userId: advisorId, reason: rejectionReason! }, update: { reason: rejectionReason! } });
        await this.outbox.add(tx, { type: 'UserSuspended', aggregateId: advisorId, correlationId: cid, payload: {
          user_id: advisorId, suspended: true, reason: rejectionReason!, entity_version: current.version, at: now.toISOString(),
        } });
      }
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: advisorId, fromStatus: 'PENDING_APPROVAL', toStatus: status,
        actorId: adminId, actorRole: 'PLATFORM_ADMIN', reason: rejectionReason, correlationId: cid, occurredAt: now } });
      await tx.adminAuditLog.create({ data: { adminId, action: `ADVISOR_${action.toUpperCase()}`, targetType: 'USER', targetId: advisorId,
        before: { status: advisor.status }, after: { status }, reason: rejectionReason, correlationId: cid, occurredAt: now } });
    });
  }

  async adminMove(adminId: string, studentId: string, advisorId: string, correlationId: string): Promise<void> {
    await this.actor(adminId, 'PLATFORM_ADMIN');
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const profile = await tx.studentProfileIdentity.findUnique({ where: { userId: studentId }, include: { user: true } });
      if (!profile || profile.user.role !== 'STUDENT') throw new AppException('NOT_FOUND', 'ไม่พบนักศึกษา', 404);
      if (profile.user.status !== 'ACTIVE') throw new AppException('STATE_CONFLICT', 'บัญชีนักศึกษาไม่พร้อมใช้งาน', 409);
      await this.targetAdvisor(tx, advisorId, profile.user.universityId);
      if (profile.advisorId === advisorId && !profile.pendingAdvisorId) throw new AppException('STATE_CONFLICT', 'ผูกอาจารย์คนนี้อยู่แล้ว', 409);
      const now = new Date();
      const changed = await tx.studentProfileIdentity.updateMany({ where: {
        userId: studentId, advisorLinkStatus: profile.advisorLinkStatus, advisorId: profile.advisorId, pendingAdvisorId: profile.pendingAdvisorId,
      }, data: { advisorLinkStatus: 'LINKED', advisorId, pendingAdvisorId: null, advisorLinkUpdatedAt: now } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลนักศึกษาถูกเปลี่ยนไปแล้ว', 409);
      await this.linkEvent(tx, { studentId, before: profile, toStatus: 'LINKED', newAdvisorId: advisorId, changedBy: 'ADMIN', actorId: adminId, correlationId: cid, now });
      await tx.adminAuditLog.create({ data: { adminId, action: 'STUDENT_ADVISOR_MOVE', targetType: 'USER', targetId: studentId,
        before: { advisor_id: profile.advisorId, pending_advisor_id: profile.pendingAdvisorId }, after: { advisor_id: advisorId }, correlationId: cid, occurredAt: now } });
    });
  }
}
