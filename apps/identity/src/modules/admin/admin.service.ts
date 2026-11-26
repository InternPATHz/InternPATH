import { Injectable } from '@nestjs/common';
import { AppException, OutboxWriter, asUuid } from '@internpath/common';
import type { AdminUniversityItem, CompanyEntitlementChangedPayload, CompanyStatusChangedPayload, UserSuspendedPayload } from '@internpath/contracts';
import { Company, Prisma, User } from '../../../generated/client';
import { assertAnotherActiveAdmin } from '../../common/student-rules';
import { PrismaService } from '../../prisma/prisma.service';
import { AdminUsersQueryDto, AuditQueryDto, SetEntitlementsDto, UpdateUniversityDto } from './admin.dto';

const isUniqueError = (error: unknown): boolean => error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
const abbreviationTaken = () => new AppException('STATE_CONFLICT', 'ตัวย่อนี้มีมหาวิทยาลัยอื่นใช้แล้ว', 409,
  [{ field: 'abbreviation', issue: 'UNIVERSITY_ABBREVIATION_TAKEN' }]);

@Injectable()
export class AdminService {
  constructor(private readonly db: PrismaService, private readonly outbox: OutboxWriter) {}

  private async admin(id: string): Promise<void> {
    const user = await this.db.user.findUnique({ where: { id } });
    if (!user || user.role !== 'PLATFORM_ADMIN') throw new AppException('FORBIDDEN_ROLE', 'เฉพาะ Admin เท่านั้น', 403);
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) throw new AppException('ACCOUNT_SUSPENDED', 'บัญชี Admin ยังใช้งานไม่ได้', 401);
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
    // Admin ระงับตัวเองจะล็อกตัวเองออกทันที (และอาจไม่เหลือ Admin ที่ปลดให้ได้)
    if (userId === adminId) throw new AppException('CANNOT_ACT_ON_SELF', 'ระงับหรือยกเลิกการระงับบัญชีของตัวเองไม่ได้', 409);
    const cid = asUuid(correlationId);
    await this.db.$transaction(async (tx) => {
      const before = await tx.user.findUnique({ where: { id: userId }, include: { companyMember: { include: { company: true } } } });
      if (!before) throw new AppException('NOT_FOUND', 'ไม่พบบัญชี', 404);
      const expected = action === 'suspend' ? 'ACTIVE' : 'SUSPENDED';
      const status = action === 'suspend' ? 'SUSPENDED' : 'ACTIVE';
      if (before.status !== expected) throw new AppException('STATE_CONFLICT', 'สถานะบัญชีไม่รองรับการดำเนินการนี้', 409);
      // ระงับ Admin คนอื่นได้ แต่ต้องเหลือ Admin ที่ใช้งานได้อย่างน้อย 1 คน (กัน A กับ B ระงับกันพร้อมกัน)
      if (action === 'suspend' && before.role === 'PLATFORM_ADMIN') await assertAnotherActiveAdmin(tx, userId);
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

  /** รหัสที่คนอ่านได้ ⇒ UUID ของบัญชี/บริษัทที่ตรงทุกตัวอักษร (รหัสนักศึกษาซ้ำข้ามมหาวิทยาลัยได้ จึงอาจได้หลายตัว) */
  private async targetIdsForCode(code: string): Promise<string[]> {
    const [users, companies] = await Promise.all([
      this.db.user.findMany({ where: { OR: [{ email: code }, { studentProfile: { is: { studentCode: code } } },
        { advisorProfile: { is: { advisorCode: code } } }] }, select: { id: true } }),
      this.db.company.findMany({ where: { registrationNo: code }, select: { id: true } }),
    ]);
    const universities = await this.db.university.findMany({ where: { OR: [{ abbreviation: code.toUpperCase() }, { emailDomain: code.toLowerCase() }] }, select: { id: true } });
    return [...users, ...companies, ...universities].map((row) => row.id);
  }

  /** ป้ายชื่อแทน UUID ในหน้า Audit: บัญชี = ชื่อ (รหัส), บริษัท = ชื่อ (เลขทะเบียน) — หาไม่เจอ (เช่นถูกลบ) ⇒ null */
  private async auditLabels(ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    const [users, companies] = await Promise.all([
      this.db.user.findMany({ where: { id: { in: unique } }, include: { studentProfile: true, advisorProfile: true } }),
      this.db.company.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, registrationNo: true } }),
    ]);
    const labels = new Map<string, string>();
    for (const user of users) {
      const code = user.studentProfile?.studentCode ?? user.advisorProfile?.advisorCode ?? user.email;
      labels.set(user.id, `${user.fullName} (${code})`);
    }
    for (const company of companies) labels.set(company.id, `${company.name} (${company.registrationNo})`);
    const universities = await this.db.university.findMany({ where: { id: { in: unique } }, select: { id: true, name: true, abbreviation: true, emailDomain: true } });
    for (const university of universities) labels.set(university.id, `${university.name} (${university.abbreviation ?? university.emailDomain})`);
    return labels;
  }

  async audit(adminId: string, query: AuditQueryDto) {
    await this.admin(adminId);
    const code = query.target_code?.trim();
    const codeIds = code ? await this.targetIdsForCode(code) : undefined;
    const where: Prisma.AdminAuditLogWhereInput = {
      ...(query.action ? { action: query.action } : {}), ...(query.target_type ? { targetType: query.target_type } : {}),
      ...(query.target_id ? { targetId: query.target_id } : {}), ...(query.admin_id ? { adminId: query.admin_id } : {}),
      ...(codeIds ? { AND: [{ targetId: { in: codeIds } }] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.adminAuditLog.findMany({ where, orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.adminAuditLog.count({ where }),
    ]);
    const labels = await this.auditLabels(rows.flatMap((row) => [row.targetId, row.adminId]));
    return { data: rows.map((row) => ({ id: row.id, admin_id: row.adminId, admin_label: labels.get(row.adminId) ?? null,
      action: row.action, target_type: row.targetType, target_id: row.targetId, target_label: labels.get(row.targetId) ?? null,
      before: row.before, after: row.after, reason: row.reason,
      correlation_id: row.correlationId, occurred_at: row.occurredAt.toISOString() })),
    meta: { page: query.page, page_size: query.page_size, total } };
  }

  async users(adminId: string, query: AdminUsersQueryDto) {
    await this.admin(adminId);
    // Prisma ส่ง contains เข้า LIKE ตรง ๆ — หนี % _ และ \ ไม่งั้นค้น "%" ได้ทุกบัญชี
    const q = query.q?.trim().replace(/[\\%_]/g, (c) => `\\${c}`);
    const where: Prisma.UserWhereInput = {
      ...(query.role ? { role: query.role } : {}),
      ...(query.status ? { status: query.status } : { status: { not: 'DELETED' } }),
      ...(query.university_id ? { universityId: query.university_id } : {}),
      ...(q ? { OR: [
        { fullName: { contains: q, mode: 'insensitive' } },
        { email: { contains: q, mode: 'insensitive' } },
        { studentProfile: { is: { studentCode: { contains: q, mode: 'insensitive' } } } },
        { advisorProfile: { is: { advisorCode: { contains: q, mode: 'insensitive' } } } },
        { companyMember: { is: { company: { registrationNo: { contains: q } } } } },
      ] } : {}),
    };
    const [rows, total] = await Promise.all([
      this.db.user.findMany({ where, include: { studentProfile: true, advisorProfile: true, companyMember: { include: { company: true } }, university: true },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.user.count({ where }),
    ]);
    return { data: rows.map((user) => ({ id: user.id, full_name: user.fullName, email: user.email,
      role: user.role, status: user.status, university_id: user.universityId, university_name: user.university?.name ?? null,
      advisor_code: user.advisorProfile?.advisorCode ?? null, company_registration_no: user.companyMember?.company.registrationNo ?? null,
      advisor_id: user.studentProfile?.advisorId ?? null, student_code: user.studentProfile?.studentCode ?? null,
      company_id: user.companyMember?.companyId ?? null, created_at: user.createdAt.toISOString() })),
    meta: { page: query.page, page_size: query.page_size, total } };
  }

  /** ตัวเลือกตัวกรองมหาวิทยาลัย — จำนวนน้อย (มาจากโดเมนอีเมลที่สมัคร) จึงคืนทั้งหมดไม่แบ่งหน้า */
  async universities(adminId: string): Promise<{ data: AdminUniversityItem[] }> {
    await this.admin(adminId);
    const rows = await this.db.university.findMany({ orderBy: [{ name: 'asc' }, { emailDomain: 'asc' }] });
    return { data: rows.map((row) => this.universityItem(row)) };
  }

  private universityItem(row: { id: string; name: string; emailDomain: string; abbreviation: string | null; active: boolean }): AdminUniversityItem {
    return { id: row.id, name: row.name, email_domain: row.emailDomain, abbreviation: row.abbreviation, active: row.active };
  }

  /**
   * PATCH /admin/universities/{id} — แก้ชื่อ/ตัวย่อที่สะกดผิด หรือเปิด/ปิดรับสมัคร (โดเมนอีเมลแก้ไม่ได้ เพราะเป็นตัวผูกบัญชี)
   * ตัวย่อซ้ำมหาวิทยาลัยอื่น ⇒ 409 `UNIVERSITY_ABBREVIATION_TAKEN` • เปลี่ยนตัวย่อแล้วรหัสอาจารย์ที่ออกไปแล้วคงเดิม
   * (เป็นรหัสที่ใช้อ้างอิงอยู่) — อาจารย์ที่สมัครหลังจากนี้ได้คำนำหน้าใหม่ • บันทึก Audit `UNIVERSITY_UPDATE` เมื่อค่าเปลี่ยนจริง
   */
  async updateUniversity(adminId: string, universityId: string, body: UpdateUniversityDto, correlationId?: string): Promise<AdminUniversityItem> {
    await this.admin(adminId);
    if (body.name === undefined && body.abbreviation === undefined && body.active === undefined) {
      throw new AppException('VALIDATION_FAILED', 'ไม่มีฟิลด์ที่แก้ไข', 400, [{ field: 'name', issue: 'EMPTY_PATCH' }]);
    }
    const cid = asUuid(correlationId);
    try {
      return await this.db.$transaction(async (tx) => {
        const before = await tx.university.findUnique({ where: { id: universityId } });
        if (!before) throw new AppException('NOT_FOUND', 'ไม่พบมหาวิทยาลัย', 404);
        if (body.abbreviation !== undefined && body.abbreviation !== before.abbreviation) {
          const taken = await tx.university.findFirst({ where: { abbreviation: body.abbreviation, id: { not: universityId } }, select: { id: true } });
          if (taken) throw abbreviationTaken();
        }
        const after = await tx.university.update({ where: { id: universityId }, data: {
          ...(body.name === undefined ? {} : { name: body.name }),
          ...(body.abbreviation === undefined ? {} : { abbreviation: body.abbreviation }),
          ...(body.active === undefined ? {} : { active: body.active }) } });
        const pick = (row: typeof before) => ({ name: row.name, abbreviation: row.abbreviation, active: row.active });
        if (JSON.stringify(pick(before)) !== JSON.stringify(pick(after))) {
          await this.auditChange(tx, adminId, 'UNIVERSITY_UPDATE', 'UNIVERSITY', universityId, pick(before), pick(after), cid);
        }
        return this.universityItem(after);
      });
    } catch (error) {
      // คำขอพร้อมกันที่ตั้งตัวย่อเดียวกันหลุดการเช็ก ⇒ unique ของ DB กันไว้
      if (isUniqueError(error)) throw abbreviationTaken();
      throw error;
    }
  }
}
