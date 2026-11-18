import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppException, OutboxWriter, asUuid } from '@internpath/common';
import type { CompanyMemberItem, CompanyStatusChangedPayload, Paginated, UserSuspendedPayload } from '@internpath/contracts';
import { Company, Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AcceptInvitationDto, MembersQueryDto } from './company-members.dto';
import { InvitationMailer } from './invitation-mailer';
import { hashPassword } from '../auth/password-hash';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const normalizedEmail = (value: string) => value.trim().toLowerCase();

@Injectable()
export class CompanyMembersService {
  constructor(private readonly db: PrismaService, private readonly outbox: OutboxWriter,
    private readonly mailer: InvitationMailer) {}

  private async member(tx: Prisma.TransactionClient, userId: string, owner = false) {
    const member = await tx.companyMember.findUnique({ where: { userId }, include: { user: true, company: true } });
    if (!member || member.user.role !== 'COMPANY_HR') {
      throw new AppException('FORBIDDEN_ROLE', 'บัญชีนี้ไม่มีสิทธิ์จัดการบริษัท', 403);
    }
    if (member.user.status !== 'ACTIVE' || !member.user.emailVerifiedAt) {
      throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ยังใช้งานไม่ได้', 401);
    }
    if (member.company.status === 'SUSPENDED') throw new AppException('FORBIDDEN_ROLE', 'บริษัทถูกระงับ', 403);
    if (owner && member.memberRole !== 'OWNER') throw new AppException('FORBIDDEN_ROLE', 'เฉพาะ Owner เท่านั้น', 403);
    return member;
  }

  private async admin(tx: Prisma.TransactionClient, userId: string): Promise<void> {
    const user = await tx.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== 'PLATFORM_ADMIN' || user.status !== 'ACTIVE' || !user.emailVerifiedAt) {
      throw new AppException('FORBIDDEN_ROLE', 'เฉพาะ Admin เท่านั้น', 403);
    }
  }

  private async audit(tx: Prisma.TransactionClient, actorId: string, action: string,
    companyId: string, before: Prisma.InputJsonValue, after: Prisma.InputJsonValue, cid: string): Promise<void> {
    await tx.adminAuditLog.create({ data: { adminId: actorId, action, targetType: 'COMPANY', targetId: companyId,
      before, after, correlationId: cid, occurredAt: new Date() } });
  }

  private async ownerEvent(tx: Prisma.TransactionClient, company: Company, ownerId: string, cid: string): Promise<void> {
    const payload: CompanyStatusChangedPayload = { company_id: company.id, status: company.status,
      previous_status: company.status, owner_user_id: ownerId, entity_version: company.version,
      snapshot: { name: company.name, ...(company.logoKey ? { logo_key: company.logoKey } : {}),
        university_partner: company.universityPartner, verified_badge: company.status === 'VERIFIED' },
      changed_at: new Date().toISOString() };
    await this.outbox.add(tx, { type: 'CompanyStatusChanged', aggregateId: company.id, correlationId: cid, payload });
  }

  private async advance(tx: Prisma.TransactionClient, company: Company): Promise<Company> {
    const changed = await tx.company.updateMany({ where: { id: company.id, version: company.version },
      data: { version: { increment: 1 } } });
    if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลบริษัทถูกเปลี่ยนแล้ว', 409);
    return tx.company.findUniqueOrThrow({ where: { id: company.id } });
  }

  private async transaction<T>(work: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T> {
    try { return await this.db.$transaction(work, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable }); }
    catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && ['P2002', 'P2034'].includes(error.code)) {
        throw new AppException('STATE_CONFLICT', 'ข้อมูลถูกเปลี่ยนพร้อมกัน กรุณาลองใหม่', 409);
      }
      throw error;
    }
  }

  async members(userId: string, query: MembersQueryDto): Promise<Paginated<CompanyMemberItem>> {
    return this.transaction(async (tx) => {
      const actor = await this.member(tx, userId);
      const where = { companyId: actor.companyId };
      const [total, rows] = await Promise.all([
        tx.companyMember.count({ where }),
        tx.companyMember.findMany({ where, include: { user: true },
          orderBy: [{ memberRole: 'asc' }, { joinedAt: 'asc' }, { userId: 'asc' }],
          skip: (query.page - 1) * query.page_size, take: query.page_size }),
      ]);
      return {
        data: rows.map((row) => ({ user_id: row.userId, full_name: row.user.fullName, email: row.user.email,
          member_role: row.memberRole, joined_at: row.joinedAt.toISOString() })),
        meta: { page: query.page, page_size: query.page_size, total },
      };
    });
  }

  async invite(ownerId: string, emailInput: string): Promise<void> {
    const email = normalizedEmail(emailInput);
    const token = randomBytes(32).toString('base64url');
    await this.transaction(async (tx) => {
      const owner = await this.member(tx, ownerId, true);
      if (email.split('@')[1] !== owner.company.emailDomain.toLowerCase()) {
        throw new AppException('VALIDATION_FAILED', 'อีเมลต้องใช้โดเมนของบริษัท', 400);
      }
      if (await tx.user.findUnique({ where: { email } })) throw new AppException('STATE_CONFLICT', 'อีเมลนี้มีบัญชีแล้ว', 409);
      const recent = await tx.companyInvitation.findFirst({ where: { companyId: owner.companyId, email,
        acceptedAt: null, expiresAt: { gt: new Date() }, createdAt: { gt: new Date(Date.now() - 60_000) } } });
      if (recent) throw new AppException('RATE_LIMITED', 'ส่งคำเชิญซ้ำเร็วเกินไป', 429);
      await tx.companyInvitation.create({ data: { companyId: owner.companyId, email,
        tokenHash: tokenHash(token), expiresAt: new Date(Date.now() + TOKEN_TTL_MS), invitedBy: ownerId } });
    });
    await this.mailer.send(email, token);
  }

  async accept(body: AcceptInvitationDto): Promise<void> {
    const hash = tokenHash(body.token);
    // Reject random public requests before performing the expensive Argon2id hash.
    const valid = await this.db.companyInvitation.findUnique({ where: { tokenHash: hash },
      select: { acceptedAt: true, expiresAt: true } });
    if (!valid || valid.acceptedAt || valid.expiresAt <= new Date()) {
      throw new AppException('INVALID_TOKEN', 'คำเชิญไม่ถูกต้องหรือหมดอายุ', 400);
    }
    const passwordHash = await hashPassword(body.password);
    await this.transaction(async (tx) => {
      const invitation = await tx.companyInvitation.findUnique({ where: { tokenHash: hash }, include: { company: true } });
      if (!invitation || invitation.acceptedAt || invitation.expiresAt <= new Date()) {
        throw new AppException('INVALID_TOKEN', 'คำเชิญไม่ถูกต้องหรือหมดอายุ', 400);
      }
      if (invitation.company.status === 'SUSPENDED') throw new AppException('STATE_CONFLICT', 'บริษัทถูกระงับ', 409);
      if (await tx.user.findUnique({ where: { email: invitation.email } })) {
        throw new AppException('STATE_CONFLICT', 'อีเมลนี้มีบัญชีแล้ว', 409);
      }
      const consumed = await tx.companyInvitation.updateMany({ where: { id: invitation.id, acceptedAt: null,
        expiresAt: { gt: new Date() } }, data: { acceptedAt: new Date() } });
      if (consumed.count !== 1) throw new AppException('STATE_CONFLICT', 'คำเชิญถูกใช้แล้ว', 409);
      const user = await tx.user.create({ data: { email: invitation.email, passwordHash,
        fullName: body.full_name.trim(), role: 'COMPANY_HR', status: 'ACTIVE', emailVerifiedAt: new Date() } });
      await tx.companyMember.create({ data: { companyId: invitation.companyId, userId: user.id,
        memberRole: 'MEMBER', invitedBy: invitation.invitedBy } });
    });
  }

  async remove(ownerId: string, memberId: string, id?: string): Promise<void> {
    const cid = asUuid(id);
    await this.transaction(async (tx) => {
      const owner = await this.member(tx, ownerId, true);
      const target = await tx.companyMember.findUnique({ where: { userId: memberId }, include: { user: true } });
      if (!target || target.companyId !== owner.companyId) throw new AppException('NOT_FOUND', 'ไม่พบสมาชิก', 404);
      if (target.memberRole === 'OWNER') throw new AppException('STATE_CONFLICT', 'ต้องโอน Owner ก่อน', 409);
      await this.advance(tx, owner.company);
      await tx.companyMember.delete({ where: { id: target.id } });
      await tx.ownerTransfer.updateMany({ where: { companyId: owner.companyId, toUserId: memberId,
        status: 'PENDING' }, data: { status: 'CANCELLED', respondedAt: new Date() } });
      const updated = await tx.user.update({ where: { id: memberId }, data: { status: 'SUSPENDED',
        suspendedReason: 'Removed from company', version: { increment: 1 } } });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: memberId, fromStatus: target.user.status,
        toStatus: 'SUSPENDED', actorId: ownerId, actorRole: 'COMPANY_HR', reason: 'Removed from company',
        correlationId: cid, occurredAt: new Date() } });
      await tx.refreshToken.updateMany({ where: { userId: memberId, revokedAt: null }, data: { revokedAt: new Date() } });
      await tx.tokenDenylist.upsert({ where: { userId: memberId }, create: { userId: memberId, reason: 'Removed from company' },
        update: { reason: 'Removed from company' } });
      const payload: UserSuspendedPayload = { user_id: memberId, suspended: true,
        reason: 'Removed from company', entity_version: updated.version, at: new Date().toISOString() };
      await this.outbox.add(tx, { type: 'UserSuspended', aggregateId: memberId, correlationId: cid, payload });
      await this.audit(tx, ownerId, 'COMPANY_MEMBER_REMOVE', owner.companyId,
        { user_id: memberId, member_role: 'MEMBER' }, { user_id: memberId, removed: true }, cid);
    });
  }

  async transfer(ownerId: string, toUserId: string): Promise<void> {
    await this.transaction(async (tx) => {
      const owner = await this.member(tx, ownerId, true);
      const target = await tx.companyMember.findUnique({ where: { userId: toUserId }, include: { user: true } });
      if (!target || target.companyId !== owner.companyId || target.memberRole !== 'MEMBER' ||
          target.user.status !== 'ACTIVE' || !target.user.emailVerifiedAt) {
        throw new AppException('NOT_FOUND', 'ไม่พบ HR Member ที่รับโอน', 404);
      }
      if (await tx.ownerTransfer.findFirst({ where: { companyId: owner.companyId, status: 'PENDING' } })) {
        throw new AppException('STATE_CONFLICT', 'มีคำขอโอน Owner ค้างอยู่', 409);
      }
      await this.advance(tx, owner.company);
      await tx.ownerTransfer.create({ data: { companyId: owner.companyId, fromUserId: ownerId, toUserId } });
    });
  }

  async transferAction(actorId: string, action: string, id?: string): Promise<void> {
    if (!['accept', 'decline', 'cancel'].includes(action)) throw new AppException('NOT_FOUND', 'ไม่พบ action นี้', 404);
    const cid = asUuid(id);
    await this.transaction(async (tx) => {
      const actor = await this.member(tx, actorId);
      const pending = await tx.ownerTransfer.findFirst({ where: { companyId: actor.companyId, status: 'PENDING' },
        orderBy: { requestedAt: 'desc' } });
      if (!pending) throw new AppException('STATE_CONFLICT', 'ไม่มีคำขอโอน Owner ที่รออยู่', 409);
      if (action === 'cancel' ? pending.fromUserId !== actorId || actor.memberRole !== 'OWNER' :
        pending.toUserId !== actorId || actor.memberRole !== 'MEMBER') {
        throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์ตอบคำขอนี้', 403);
      }
      if (action !== 'accept') {
        const changed = await tx.ownerTransfer.updateMany({ where: { id: pending.id, status: 'PENDING' },
          data: { status: 'CANCELLED', respondedAt: new Date() } });
        if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'คำขอถูกตอบไปแล้ว', 409);
        return;
      }
      const owner = await tx.companyMember.findUnique({ where: { userId: pending.fromUserId }, include: { user: true } });
      if (!owner || owner.companyId !== actor.companyId || owner.memberRole !== 'OWNER' ||
          owner.user.status !== 'ACTIVE') throw new AppException('STATE_CONFLICT', 'Owner เดิมเปลี่ยนแล้ว', 409);
      const company = await this.advance(tx, actor.company);
      const demoted = await tx.companyMember.updateMany({ where: { id: owner.id, memberRole: 'OWNER' },
        data: { memberRole: 'MEMBER' } });
      const promoted = await tx.companyMember.updateMany({ where: { id: actor.id, memberRole: 'MEMBER' },
        data: { memberRole: 'OWNER' } });
      if (demoted.count !== 1 || promoted.count !== 1) throw new AppException('STATE_CONFLICT', 'สมาชิกเปลี่ยนแล้ว', 409);
      await tx.ownerTransfer.update({ where: { id: pending.id }, data: { status: 'ACCEPTED', respondedAt: new Date() } });
      await this.ownerEvent(tx, company, actorId, cid);
      await this.audit(tx, actorId, 'COMPANY_OWNER_TRANSFER', company.id,
        { owner_user_id: owner.userId }, { owner_user_id: actorId }, cid);
    });
  }

  async appoint(adminId: string, companyId: string, userId: string, id?: string): Promise<void> {
    const cid = asUuid(id);
    await this.transaction(async (tx) => {
      await this.admin(tx, adminId);
      const company = await tx.company.findUnique({ where: { id: companyId } });
      if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
      if (await tx.companyMember.findFirst({ where: { companyId, memberRole: 'OWNER' } })) {
        throw new AppException('STATE_CONFLICT', 'บริษัทยังมี Owner อยู่', 409);
      }
      const target = await tx.companyMember.findUnique({ where: { userId }, include: { user: true } });
      if (!target || target.companyId !== companyId || target.memberRole !== 'MEMBER' ||
          target.user.status !== 'ACTIVE' || !target.user.emailVerifiedAt) {
        throw new AppException('NOT_FOUND', 'ไม่พบ HR Member ที่แต่งตั้งได้', 404);
      }
      const updated = await this.advance(tx, company);
      await tx.ownerTransfer.updateMany({ where: { companyId, status: 'PENDING' },
        data: { status: 'CANCELLED', respondedAt: new Date() } });
      await tx.companyMember.update({ where: { id: target.id }, data: { memberRole: 'OWNER' } });
      await this.ownerEvent(tx, updated, userId, cid);
      await this.audit(tx, adminId, 'COMPANY_OWNER_APPOINT', companyId,
        { owner_user_id: null }, { owner_user_id: userId }, cid);
    });
  }
}
