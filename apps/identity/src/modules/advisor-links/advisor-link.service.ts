import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { AppException, OutboxWriter, asUuid } from '@internpath/common';
import type { AdminAdvisorListItem, AdvisorLinkChangedPayload, AdvisorStudentItem, CreateStudentResponse } from '@internpath/contracts';
import { Prisma, StudentProfileIdentity, User } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthMailer } from '../auth/auth.mailer';
import { AuthService, STUDENT_INVITATION_TTL_MS } from '../auth/auth.service';
import { AdminAdvisorQueryDto, AdvisorStudentsQueryDto, CreateStudentDto, UpdateStudentDto } from './advisor-link.dto';

const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const isUniqueError = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const isSerializationError = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034';
/** P2002 จาก unique (university_id, student_code) — `meta.target` เป็นรายชื่อคอลัมน์หรือชื่อ constraint แล้วแต่ engine */
const isStudentCodeUniqueError = (error: unknown): boolean =>
  isUniqueError(error) && /student_?code/i.test(JSON.stringify((error as Prisma.PrismaClientKnownRequestError).meta?.target ?? ''));
const studentCodeTaken = () =>
  new AppException('STATE_CONFLICT', 'รหัสนักศึกษานี้ถูกใช้แล้วในสถาบันเดียวกัน', 409, [{ field: 'student_code', issue: 'STUDENT_CODE_ALREADY_USED' }]);

type Page<T> = { data: T[]; meta: { page: number; page_size: number; total: number } };

function page<T>(data: T[], total: number, query: { page: number; page_size: number }): Page<T> {
  return { data, meta: { page: query.page, page_size: query.page_size, total } };
}

@Injectable()
export class AdvisorLinkService {
  constructor(private readonly db: PrismaService, private readonly outbox: OutboxWriter,
    private readonly auth: AuthService, private readonly mailer: AuthMailer) {}

  private async actor(id: string, role?: User['role']): Promise<User> {
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user || (role && user.role !== role)) throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์ดำเนินการ', 403);
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ยังใช้งานไม่ได้', 401);
    return user;
  }

  private async targetAdvisor(tx: Prisma.TransactionClient, advisorId: string, universityId: string | null): Promise<User> {
    const advisor = await tx.user.findUnique({ where: { id: advisorId } });
    if (!advisor || advisor.role !== 'ADVISOR') throw new AppException('NOT_FOUND', 'ไม่พบอาจารย์ที่ปรึกษา', 404);
    if (advisor.status !== 'ACTIVE' || !advisor.emailVerifiedAt) throw new AppException('STATE_CONFLICT', 'อาจารย์ยังไม่พร้อมรับคำขอ', 409);
    if (!universityId || advisor.universityId !== universityId) throw new AppException('FORBIDDEN_ROLE', 'อาจารย์ต้องอยู่สถาบันเดียวกัน', 403);
    return advisor;
  }

  private async linkEvent(tx: Prisma.TransactionClient, args: {
    studentId: string; before: StudentProfileIdentity; toStatus: Extract<StudentProfileIdentity['advisorLinkStatus'], 'LINKED' | 'NONE'>;
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

  /** รหัสนักศึกษาซ้ำในสถาบันเดียวกัน — ดูจาก `university_id` ของโปรไฟล์ ให้ตรงกับ unique (university_id, student_code) */
  private async studentCodeInUse(client: Prisma.TransactionClient, universityId: string, studentCode: string): Promise<boolean> {
    const duplicate = await client.studentProfileIdentity.findFirst({
      where: { studentCode, universityId, user: { status: { not: 'DELETED' } } }, select: { userId: true } });
    return duplicate !== null;
  }

  /**
   * อาจารย์เพิ่มนักศึกษา (ปรับ Requirement 2026-11-21): สร้างบัญชี `STUDENT` ที่ยังไม่มีรหัสผ่าน ผูกอาจารย์เป็น `LINKED` ทันที
   * (ส่ง AdvisorLinkChanged) และส่งอีเมลคำเชิญอายุ 7 วัน — นักศึกษาตั้งรหัสผ่านผ่าน `POST /auth/student-invitations/accept`
   */
  async createStudent(advisorId: string, body: CreateStudentDto, correlationId: string): Promise<CreateStudentResponse> {
    const advisor = await this.actor(advisorId, 'ADVISOR');
    const universityId = advisor.universityId;
    if (!universityId) throw new AppException('FORBIDDEN_ROLE', 'อาจารย์ยังไม่ผูกสถาบัน', 403);
    const university = await this.db.university.findUniqueOrThrow({ where: { id: universityId } });
    const email = normalizeEmail(body.email);
    if (email.split('@')[1] !== university.emailDomain.toLowerCase()) {
      throw new AppException('VALIDATION_FAILED', 'อีเมลนักศึกษาต้องใช้โดเมนสถาบันเดียวกับอาจารย์', 400, [{ field: 'email', issue: 'EMAIL_DOMAIN_NOT_ALLOWED' }]);
    }
    const cid = asUuid(correlationId);
    let token = '';
    let studentId = '';
    let expiresAt = new Date();
    try {
      await this.db.$transaction(async (tx) => {
        if (await tx.user.findUnique({ where: { email } })) {
          throw new AppException('STATE_CONFLICT', 'อีเมลนี้ลงทะเบียนแล้ว', 409, [{ field: 'email', issue: 'EMAIL_ALREADY_REGISTERED' }]);
        }
        // เช็กก่อนเพื่อตอบ 409 ที่ชัดเจน; คำขอพร้อมกันที่หลุดไปชน unique (university_id, student_code) ใน DB ⇒ แปลงเป็น 409 เดียวกันด้านล่าง
        const studentCode = body.student_code.trim();
        if (await this.studentCodeInUse(tx, universityId, studentCode)) throw studentCodeTaken();
        const now = new Date();
        const user = await tx.user.create({ data: {
          email, passwordHash: null, fullName: body.full_name.trim(), role: 'STUDENT', status: 'PENDING_EMAIL', universityId,
          studentProfile: { create: { universityId, studentCode, major: body.major.trim(), yearLevel: body.year_level, advisorId,
            advisorLinkStatus: 'LINKED', createdByAdvisorId: advisorId, advisorLinkUpdatedAt: now } },
        } });
        studentId = user.id;
        token = await this.auth.issueEmailToken(tx, user.id, 'STUDENT_INVITATION');
        expiresAt = new Date(Date.now() + STUDENT_INVITATION_TTL_MS);
        await tx.statusHistory.create({ data: { entity: 'USER', entityId: user.id, fromStatus: null, toStatus: 'PENDING_EMAIL',
          actorId: advisorId, actorRole: 'ADVISOR', reason: 'STUDENT_CREATED_BY_ADVISOR', correlationId: cid, occurredAt: now } });
        await this.linkEvent(tx, { studentId: user.id, before: { advisorId: null, advisorLinkStatus: 'NONE' } as StudentProfileIdentity,
          toStatus: 'LINKED', newAdvisorId: advisorId, changedBy: 'ADVISOR', actorId: advisorId, correlationId: cid, now });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      if (isStudentCodeUniqueError(error)) throw studentCodeTaken();
      if (isUniqueError(error)) throw new AppException('STATE_CONFLICT', 'อีเมลนี้ลงทะเบียนแล้ว', 409, [{ field: 'email', issue: 'EMAIL_ALREADY_REGISTERED' }]);
      if (isSerializationError(error)) {
        if (await this.db.user.findUnique({ where: { email } }))
          throw new AppException('STATE_CONFLICT', 'อีเมลนี้ลงทะเบียนแล้ว', 409, [{ field: 'email', issue: 'EMAIL_ALREADY_REGISTERED' }]);
        if (await this.studentCodeInUse(this.db, universityId, body.student_code.trim())) throw studentCodeTaken();
        throw new AppException('STATE_CONFLICT', 'ข้อมูลถูกเปลี่ยนระหว่างบันทึก กรุณาลองใหม่', 409);
      }
      throw error;
    }
    // บัญชีถูกสร้างแล้ว: ส่งอีเมลไม่สำเร็จไม่ทำให้คำขอล้ม — อาจารย์กดส่งคำเชิญใหม่ได้
    try { await this.mailer.send(email, 'student-invitation', token); } catch { /* resend-invitation */ }
    return { student_user_id: studentId, email, invitation_expires_at: expiresAt.toISOString() };
  }

  /** นักศึกษาในความดูแลของอาจารย์ (ไม่ใช่ของตน ⇒ 404) */
  private async ownedStudent(tx: Prisma.TransactionClient, advisorId: string, studentId: string) {
    const profile = await tx.studentProfileIdentity.findUnique({ where: { userId: studentId }, include: { user: true } });
    if (!profile || profile.advisorId !== advisorId || profile.advisorLinkStatus !== 'LINKED' || profile.user.status === 'DELETED') {
      throw new AppException('NOT_FOUND', 'ไม่พบนักศึกษาในความดูแล', 404);
    }
    return profile;
  }

  async updateStudent(advisorId: string, studentId: string, body: UpdateStudentDto): Promise<void> {
    await this.actor(advisorId, 'ADVISOR');
    await this.db.$transaction(async (tx) => {
      const profile = await this.ownedStudent(tx, advisorId, studentId);
      const fullName = body.full_name === undefined ? undefined : body.full_name.trim();
      const major = body.major === undefined ? undefined : body.major.trim();
      if (fullName === '' || major === '') throw new AppException('VALIDATION_FAILED', 'ค่าที่แก้ไขต้องไม่ว่าง', 400);
      if (fullName !== undefined || body.year_level !== undefined || major !== undefined) {
        await tx.user.update({ where: { id: studentId }, data: { ...(fullName === undefined ? {} : { fullName }), version: { increment: 1 } } });
        await tx.studentProfileIdentity.update({ where: { userId: profile.userId },
          data: { ...(major === undefined ? {} : { major }), ...(body.year_level === undefined ? {} : { yearLevel: body.year_level }) } });
      }
    });
  }

  /** ส่งคำเชิญใหม่ (ลิงก์เดิมใช้ไม่ได้) — ได้เฉพาะนักศึกษาที่ยังไม่ตั้งรหัสผ่าน */
  async resendInvitation(advisorId: string, studentId: string): Promise<void> {
    await this.actor(advisorId, 'ADVISOR');
    const { token, email } = await this.db.$transaction(async (tx) => {
      const profile = await this.ownedStudent(tx, advisorId, studentId);
      if (profile.user.status !== 'PENDING_EMAIL' || profile.user.passwordHash !== null) {
        throw new AppException('STATE_CONFLICT', 'นักศึกษาตั้งรหัสผ่านแล้ว', 409);
      }
      await tx.emailToken.updateMany({ where: { userId: studentId, purpose: 'STUDENT_INVITATION', usedAt: null }, data: { usedAt: new Date() } });
      return { token: await this.auth.issueEmailToken(tx, studentId, 'STUDENT_INVITATION'), email: profile.user.email };
    });
    try { await this.mailer.send(email, 'student-invitation', token); }
    catch { throw new AppException('MAIL_UNAVAILABLE', 'ส่งอีเมลคำเชิญไม่สำเร็จ กรุณาลองใหม่', 503); }
  }

  /** ยกเลิกบัญชีที่ยังไม่ตั้งรหัสผ่าน: ลบคำเชิญ + ทำให้บัญชีเป็น DELETED (คืนอีเมลให้ใช้สร้างใหม่ได้) และส่ง AdvisorLinkChanged(UNLINKED) */
  async cancelInvitation(advisorId: string, studentId: string, correlationId: string): Promise<void> {
    await this.actor(advisorId, 'ADVISOR');
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const profile = await this.ownedStudent(tx, advisorId, studentId);
      if (profile.user.status !== 'PENDING_EMAIL' || profile.user.passwordHash !== null) {
        throw new AppException('STATE_CONFLICT', 'นักศึกษาตั้งรหัสผ่านแล้ว', 409);
      }
      const now = new Date();
      await tx.emailToken.deleteMany({ where: { userId: studentId } });
      await tx.studentProfileIdentity.delete({ where: { userId: studentId } });
      const deleted = await tx.user.update({ where: { id: studentId }, data: {
        email: `deleted-${randomUUID()}@invalid.example`, fullName: 'บัญชีที่ถูกยกเลิก', universityId: null, status: 'DELETED',
        deletedAt: now, version: { increment: 1 } } });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: studentId, fromStatus: 'PENDING_EMAIL', toStatus: 'DELETED',
        actorId: advisorId, actorRole: 'ADVISOR', reason: 'STUDENT_INVITATION_CANCELLED', correlationId: cid, occurredAt: now } });
      const payload: AdvisorLinkChangedPayload = { student_user_id: studentId, old_advisor_id: advisorId, link_status: 'UNLINKED',
        changed_by: 'ADVISOR', entity_version: deleted.version, changed_at: now.toISOString() };
      await this.outbox.add(tx, { type: 'AdvisorLinkChanged', aggregateId: studentId, correlationId: cid, payload });
    });
  }

  /** รายชื่อสำหรับจัดการบัญชี + ตัวกรองชั้นปี/สถานะเปิดใช้งาน (สถานะการฝึกงานอยู่ที่ Lifecycle `GET /advisor/students`) */
  async students(advisorId: string, query: AdvisorStudentsQueryDto): Promise<Page<AdvisorStudentItem>> {
    await this.actor(advisorId, 'ADVISOR');
    const q = query.q?.trim();
    const where: Prisma.StudentProfileIdentityWhereInput = {
      advisorId, advisorLinkStatus: 'LINKED', user: { status: query.activation === 'PENDING' ? 'PENDING_EMAIL' : query.activation === 'ACTIVE' ? 'ACTIVE' : { not: 'DELETED' } },
      ...(query.year_level === undefined ? {} : { yearLevel: query.year_level }),
      ...(q ? { OR: [
        { studentCode: { contains: q, mode: 'insensitive' } },
        { user: { is: { fullName: { contains: q, mode: 'insensitive' } } } },
        { user: { is: { email: { contains: q, mode: 'insensitive' } } } },
      ] } : {}),
    };
    const [profiles, total] = await Promise.all([
      this.db.studentProfileIdentity.findMany({ where, include: { user: true }, orderBy: [{ createdAt: 'asc' }, { userId: 'asc' }], skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.studentProfileIdentity.count({ where }),
    ]);
    const pendingIds = profiles.filter((p) => p.user.status === 'PENDING_EMAIL').map((p) => p.userId);
    const tokens = pendingIds.length ? await this.db.emailToken.findMany({ where: { userId: { in: pendingIds }, purpose: 'STUDENT_INVITATION', usedAt: null },
      orderBy: { createdAt: 'desc' }, select: { userId: true, expiresAt: true } }) : [];
    const expiry = new Map<string, Date>();
    for (const token of tokens) if (!expiry.has(token.userId)) expiry.set(token.userId, token.expiresAt);
    return page(profiles.map((profile): AdvisorStudentItem => {
      const pending = profile.user.status === 'PENDING_EMAIL';
      const expires = expiry.get(profile.userId);
      return { user_id: profile.userId, full_name: profile.user.fullName, email: profile.user.email, student_code: profile.studentCode,
        major: profile.major, year_level: profile.yearLevel, activation_status: pending ? 'PENDING' : 'ACTIVE',
        ...(pending && expires ? { invitation_expires_at: expires.toISOString() } : {}) };
    }), total, query);
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
      if (profile.advisorId === advisorId) throw new AppException('STATE_CONFLICT', 'ผูกอาจารย์คนนี้อยู่แล้ว', 409);
      const now = new Date();
      const changed = await tx.studentProfileIdentity.updateMany({ where: {
        userId: studentId, advisorLinkStatus: profile.advisorLinkStatus, advisorId: profile.advisorId,
      }, data: { advisorLinkStatus: 'LINKED', advisorId, advisorLinkUpdatedAt: now } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลนักศึกษาถูกเปลี่ยนไปแล้ว', 409);
      await this.linkEvent(tx, { studentId, before: profile, toStatus: 'LINKED', newAdvisorId: advisorId, changedBy: 'ADMIN', actorId: adminId, correlationId: cid, now });
      await tx.adminAuditLog.create({ data: { adminId, action: 'STUDENT_ADVISOR_MOVE', targetType: 'USER', targetId: studentId,
        before: { advisor_id: profile.advisorId }, after: { advisor_id: advisorId }, correlationId: cid, occurredAt: now } });
    });
  }
}
