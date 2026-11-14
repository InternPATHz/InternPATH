import { randomBytes, randomUUID } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { AppException, OutboxWriter } from '@internpath/common';
import type { AdvisorLinkChangedPayload, UserDeletionRequestedPayload, UserSuspendedPayload } from '@internpath/contracts';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';

export const DELETION_ELIGIBILITY = Symbol('DELETION_ELIGIBILITY');

export interface DeletionEligibility {
  assertNoActiveApplications(userId: string): Promise<void>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correlation = (value?: string): string => value && UUID.test(value) ? value : randomUUID();

@Injectable()
export class AccountDeletionService {
  constructor(
    private readonly db: PrismaService,
    private readonly outbox: OutboxWriter,
    @Inject(DELETION_ELIGIBILITY) private readonly eligibility: DeletionEligibility,
  ) {}

  async request(userId: string): Promise<string> {
    return this.db.$transaction(async (tx) => {
      const user = await tx.user.findUnique({ where: { id: userId }, include: { companyMember: true } });
      if (!user || user.status === 'DELETED') throw new AppException('UNAUTHENTICATED', 'ไม่พบบัญชีที่ใช้งานได้', 401);
      if (user.companyMember?.memberRole === 'OWNER') {
        throw new AppException('DELETION_BLOCKED', 'ต้องโอนสิทธิ์ Owner ก่อนลบบัญชี', 422);
      }
      const pending = await tx.deletionRequest.findFirst({ where: { userId, status: 'REQUESTED' } });
      if (pending) return pending.id;
      return (await tx.deletionRequest.create({ data: { userId, status: 'REQUESTED' } })).id;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  // The production eligibility provider fails closed until Lifecycle exposes the required Internal API.
  async complete(requestId: string, correlationId?: string): Promise<void> {
    const request = await this.db.deletionRequest.findUnique({ where: { id: requestId } });
    if (!request) throw new AppException('NOT_FOUND', 'ไม่พบคำขอลบบัญชี', 404);
    if (request.status === 'COMPLETED') return;
    if (request.status !== 'REQUESTED') throw new AppException('DELETION_BLOCKED', 'คำขอนี้ถูกปฏิเสธแล้ว', 422);
    try {
      await this.eligibility.assertNoActiveApplications(request.userId);
    } catch (error) {
      if (error instanceof AppException && error.code === 'DELETION_BLOCKED') {
        await this.db.deletionRequest.updateMany({ where: { id: requestId, status: 'REQUESTED' },
          data: { status: 'BLOCKED', blockedReason: 'ACTIVE_APPLICATION' } });
      }
      throw error;
    }

    const cid = correlation(correlationId);
    await this.db.$transaction(async (tx) => {
      const currentRequest = await tx.deletionRequest.findUnique({ where: { id: requestId } });
      if (currentRequest?.status === 'COMPLETED') return;
      if (currentRequest?.status !== 'REQUESTED') throw new AppException('STATE_CONFLICT', 'คำขอถูกเปลี่ยนสถานะแล้ว', 409);
      const user = await tx.user.findUnique({ where: { id: currentRequest.userId }, include: { companyMember: true } });
      if (!user || user.status === 'DELETED') throw new AppException('STATE_CONFLICT', 'บัญชีถูกลบแล้ว', 409);
      if (user.companyMember?.memberRole === 'OWNER') {
        throw new AppException('DELETION_BLOCKED', 'ต้องโอนสิทธิ์ Owner ก่อนลบบัญชี', 422);
      }

      const userId = user.id;
      const anonymousId = randomUUID();
      const now = new Date();
      const companyId = user.companyMember?.companyId;

      if (user.role === 'ADVISOR') await this.unlinkAdvisor(tx, userId, anonymousId, cid, now);
      await tx.companyInvitation.updateMany({ where: { email: user.email },
        data: { email: `deleted-${randomUUID()}@invalid.example` } });
      await tx.companyInvitation.updateMany({ where: { invitedBy: userId }, data: { invitedBy: anonymousId } });
      await tx.companyDocument.updateMany({ where: { uploadedBy: userId }, data: { uploadedBy: anonymousId } });
      await tx.ownerTransfer.updateMany({ where: { OR: [{ fromUserId: userId }, { toUserId: userId }], status: 'PENDING' },
        data: { status: 'CANCELLED', respondedAt: now } });
      await tx.ownerTransfer.updateMany({ where: { fromUserId: userId }, data: { fromUserId: anonymousId } });
      await tx.ownerTransfer.updateMany({ where: { toUserId: userId }, data: { toUserId: anonymousId } });
      await tx.companyMember.updateMany({ where: { invitedBy: userId }, data: { invitedBy: anonymousId } });
      await tx.advisorProfile.updateMany({ where: { approvedBy: userId }, data: { approvedBy: anonymousId } });
      await tx.companyMember.deleteMany({ where: { userId } });
      await tx.studentProfileIdentity.deleteMany({ where: { userId } });
      await tx.advisorProfile.deleteMany({ where: { userId } });
      await tx.consent.deleteMany({ where: { userId } });
      await tx.emailToken.deleteMany({ where: { userId } });
      await tx.refreshToken.deleteMany({ where: { userId } });

      await tx.$executeRaw`SET LOCAL internpath.anonymize = 'on'`;
      await tx.$queryRaw`SELECT set_config('internpath.anonymous_actor_id', ${anonymousId}, true)`;
      await tx.statusHistory.updateMany({ where: { actorId: userId }, data: { actorId: anonymousId } });
      await tx.adminAuditLog.updateMany({ where: { adminId: userId }, data: { adminId: anonymousId } });

      const changed = await tx.user.updateMany({ where: { id: userId, version: user.version, status: user.status },
        data: { email: `deleted-${randomUUID()}@invalid.example`, passwordHash: `deleted:${randomBytes(32).toString('hex')}`,
          fullName: 'ผู้ใช้ที่ลบบัญชีแล้ว', phone: null, universityId: null, emailVerifiedAt: null,
          status: 'DELETED', deletedAt: now, suspendedReason: null, failedLoginCount: 0, lockedUntil: null,
          version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'บัญชีถูกเปลี่ยนแล้ว', 409);
      await tx.tokenDenylist.upsert({ where: { userId }, create: { userId, reason: 'Account deleted' },
        update: { reason: 'Account deleted' } });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: userId, fromStatus: user.status,
        toStatus: 'DELETED', actorId: anonymousId, actorRole: user.role, correlationId: cid, occurredAt: now } });
      await tx.deletionRequest.update({ where: { id: requestId }, data: { status: 'COMPLETED', completedAt: now } });

      const deleted: UserDeletionRequestedPayload = { user_id: userId, role: user.role,
        ...(companyId ? { company_id: companyId } : {}), requested_at: currentRequest.requestedAt.toISOString(),
        mode: 'DELETE_AND_ANONYMIZE', anonymous_actor_id: anonymousId };
      const suspended: UserSuspendedPayload = { user_id: userId, suspended: true, reason: 'Account deleted',
        entity_version: user.version + 1, at: now.toISOString() };
      await this.outbox.add(tx, { type: 'UserDeletionRequested', aggregateId: userId, correlationId: cid, payload: deleted });
      await this.outbox.add(tx, { type: 'UserSuspended', aggregateId: userId, correlationId: cid, payload: suspended });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async unlinkAdvisor(tx: Prisma.TransactionClient, advisorId: string, anonymousId: string,
    cid: string, now: Date): Promise<void> {
    const links = await tx.studentProfileIdentity.findMany({
      where: { OR: [{ advisorId }, { pendingAdvisorId: advisorId }] },
    });
    for (const link of links) {
      const nextAdvisor = link.advisorId === advisorId ? null : link.advisorId;
      const nextPending = link.pendingAdvisorId === advisorId ? null : link.pendingAdvisorId;
      const nextStatus = nextPending ? 'ADVISOR_LINK_PENDING' : nextAdvisor ? 'LINKED' : 'NONE';
      const updated = await tx.studentProfileIdentity.updateMany({ where: { userId: link.userId,
        advisorId: link.advisorId, pendingAdvisorId: link.pendingAdvisorId },
      data: { advisorId: nextAdvisor, pendingAdvisorId: nextPending,
        advisorLinkStatus: nextStatus, advisorLinkUpdatedAt: now } });
      if (updated.count !== 1) throw new AppException('STATE_CONFLICT', 'การผูกอาจารย์ถูกเปลี่ยนแล้ว', 409);
      const student = await tx.user.update({ where: { id: link.userId }, data: { version: { increment: 1 } } });
      const payload: AdvisorLinkChangedPayload = { student_user_id: link.userId,
        ...(link.advisorId ? { old_advisor_id: link.advisorId } : {}),
        ...(nextAdvisor ? { new_advisor_id: nextAdvisor } : {}),
        link_status: nextStatus === 'NONE' ? 'UNLINKED' : nextStatus,
        changed_by: 'ADVISOR', entity_version: student.version, changed_at: now.toISOString() };
      await this.outbox.add(tx, { type: 'AdvisorLinkChanged', aggregateId: link.userId, correlationId: cid, payload });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: link.userId,
        fromStatus: link.advisorLinkStatus, toStatus: nextStatus, actorId: anonymousId,
        actorRole: 'ADVISOR', reason: 'ADVISOR_ACCOUNT_DELETED', correlationId: cid, occurredAt: now } });
    }
  }
}
