import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { fromBuffer } from 'file-type';
import { AppException, OutboxWriter } from '@internpath/common';
import type { AdminCompanyDetail, AdminCompanyListItem, CompanyDocType, CompanyDocumentItem, CompanyMeResponse, CompanyStatusChangedPayload } from '@internpath/contracts';
import { Company, CompanyStatus, Prisma, User } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { CompanyStorageService } from './company-storage.service';
import { CompanyQueryDto, UpdateCompanyDto } from './companies.dto';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const correlation = (id?: string) => id && UUID.test(id) ? id : randomUUID();
type Page<T> = { data: T[]; meta: { page: number; page_size: number; total: number } };

@Injectable()
export class CompaniesService {
  constructor(private readonly db: PrismaService, private readonly outbox: OutboxWriter, private readonly storage: CompanyStorageService) {}

  private async actor(userId: string, role: User['role']): Promise<User> {
    const user = await this.db.user.findUnique({ where: { id: userId } });
    if (!user || user.role !== role) throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์ดำเนินการ', 403);
    if (user.status !== 'ACTIVE' || !user.emailVerifiedAt) throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ยังใช้งานไม่ได้', 403);
    return user;
  }

  private async member(userId: string, owner = false) {
    await this.actor(userId, 'COMPANY_HR');
    const member = await this.db.companyMember.findUnique({ where: { userId }, include: { company: true } });
    if (!member) throw new AppException('FORBIDDEN_ROLE', 'ไม่พบสมาชิกบริษัท', 403);
    if (owner && member.memberRole !== 'OWNER') throw new AppException('FORBIDDEN_ROLE', 'เฉพาะ Owner เท่านั้น', 403);
    return member;
  }

  private response(company: Company): CompanyMeResponse {
    return { id: company.id, name: company.name, registration_no: company.registrationNo,
      ...(company.website ? { website: company.website } : {}), ...(company.phone ? { phone: company.phone } : {}),
      ...(company.logoKey ? { logo_url: this.storage.publicUrl(company.logoKey) } : {}), status: company.status,
      ...(company.reviewNote ? { review_note: company.reviewNote } : {}), university_partner: company.universityPartner,
      featured_enabled: company.featuredEnabled, fast_track_enabled: company.fastTrackEnabled };
  }

  private async event(tx: Prisma.TransactionClient, before: Company, after: Company, actorId: string, cid: string, reason?: string): Promise<void> {
    const owner = await tx.companyMember.findFirst({ where: { companyId: after.id, memberRole: 'OWNER' } });
    const payload: CompanyStatusChangedPayload = {
      company_id: after.id, status: after.status, previous_status: before.status,
      snapshot: { name: after.name, ...(after.logoKey ? { logo_key: after.logoKey } : {}),
        university_partner: after.universityPartner, verified_badge: after.status === 'VERIFIED' },
      ...(owner ? { owner_user_id: owner.userId } : {}), ...(reason ? { reason } : {}),
      entity_version: after.version, changed_at: new Date().toISOString(),
    };
    await this.outbox.add(tx, { type: 'CompanyStatusChanged', aggregateId: after.id, correlationId: cid, payload });
    if (before.status !== after.status) await tx.statusHistory.create({ data: {
      entity: 'COMPANY', entityId: after.id, fromStatus: before.status, toStatus: after.status,
      actorId, actorRole: actorId === owner?.userId ? 'COMPANY_HR' : 'PLATFORM_ADMIN',
      reason: reason ?? null, correlationId: cid, occurredAt: new Date(),
    } });
  }

  async me(userId: string): Promise<CompanyMeResponse> {
    const member = await this.member(userId);
    return this.response(member.company);
  }

  async update(userId: string, body: UpdateCompanyDto, id?: string): Promise<CompanyMeResponse> {
    const member = await this.member(userId, true);
    const before = member.company;
    const name = body.name?.trim() ?? before.name;
    const website = body.website?.trim() ?? before.website;
    const phone = body.phone?.trim() ?? before.phone;
    if (name === before.name && website === before.website && phone === before.phone) return this.response(before);
    const status: CompanyStatus = before.status === 'REJECTED' ? 'PENDING' : before.status;
    const cid = correlation(id);
    const after = await this.db.$transaction(async (tx) => {
      const changed = await tx.company.updateMany({ where: { id: before.id, version: before.version, status: before.status },
        data: { name, website, phone, status, reviewNote: status === 'PENDING' ? null : before.reviewNote, version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลบริษัทถูกเปลี่ยนแล้ว', 409);
      const current = await tx.company.findUniqueOrThrow({ where: { id: before.id } });
      if (name !== before.name || status !== before.status) await this.event(tx, before, current, userId, cid);
      return current;
    });
    return this.response(after);
  }

  private async checkedFile(file: Express.Multer.File | undefined, expected: 'logo' | 'document'): Promise<string> {
    if (!file?.buffer?.length) throw new AppException('VALIDATION_ERROR', 'ต้องส่งไฟล์', 400);
    if (file.buffer.length > (expected === 'logo' ? 2 : 5) * 1024 * 1024) throw new AppException('FILE_TOO_LARGE', 'ไฟล์ใหญ่เกินกำหนด', 413);
    const detected = await fromBuffer(file.buffer);
    const allowed = expected === 'document' ? ['application/pdf'] : ['image/jpeg', 'image/png', 'image/webp'];
    if (!detected || !allowed.includes(detected.mime)) throw new AppException('UNSUPPORTED_FILE_TYPE', 'ชนิดไฟล์ไม่ถูกต้อง', 422);
    return detected.mime;
  }

  async logo(userId: string, file: Express.Multer.File, id?: string): Promise<CompanyMeResponse> {
    const member = await this.member(userId, true);
    const mime = await this.checkedFile(file, 'logo');
    const key = await this.storage.upload('logo', member.companyId, file.buffer, mime);
    const cid = correlation(id);
    const after = await this.db.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: member.companyId } });
      const changed = await tx.company.updateMany({ where: { id: before.id, version: before.version }, data: { logoKey: key, version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'ข้อมูลบริษัทถูกเปลี่ยนแล้ว', 409);
      const current = await tx.company.findUniqueOrThrow({ where: { id: before.id } });
      await this.event(tx, before, current, userId, cid);
      return current;
    });
    return this.response(after);
  }

  async document(userId: string, docType: CompanyDocType, file: Express.Multer.File): Promise<{ id: string }> {
    const member = await this.member(userId, true);
    const mime = await this.checkedFile(file, 'document');
    const key = await this.storage.upload('document', member.companyId, file.buffer, mime);
    const document = await this.db.companyDocument.create({ data: { companyId: member.companyId, docType, objectKey: key,
      mime, sizeBytes: file.buffer.length, uploadedBy: userId } });
    return { id: document.id };
  }

  private async documentsFor(companyId: string): Promise<CompanyDocumentItem[]> {
    const docs = await this.db.companyDocument.findMany({ where: { companyId }, orderBy: { createdAt: 'desc' } });
    return Promise.all(docs.map(async (doc) => ({ id: doc.id, doc_type: doc.docType as CompanyDocType, mime: doc.mime,
      size_bytes: doc.sizeBytes, url: await this.storage.signedUrl(doc.objectKey), created_at: doc.createdAt.toISOString() })));
  }

  async documents(userId: string): Promise<CompanyDocumentItem[]> {
    const member = await this.member(userId);
    return this.documentsFor(member.companyId);
  }

  async resubmit(userId: string, id?: string): Promise<void> {
    const member = await this.member(userId, true);
    const cid = correlation(id);
    await this.db.$transaction(async (tx) => {
      const before = await tx.company.findUniqueOrThrow({ where: { id: member.companyId } });
      if (before.status !== 'NEED_MORE_INFO') throw new AppException('STATE_CONFLICT', 'บริษัทไม่ได้รอเอกสารเพิ่มเติม', 409);
      const lastReview = await tx.statusHistory.findFirst({ where: { entity: 'COMPANY', entityId: before.id, toStatus: 'NEED_MORE_INFO' }, orderBy: { occurredAt: 'desc' } });
      const added = await tx.companyDocument.count({ where: { companyId: before.id, createdAt: { gt: lastReview?.occurredAt ?? before.createdAt } } });
      if (!added) throw new AppException('DOCUMENT_REQUIRED', 'ต้องอัปโหลดเอกสารเพิ่มเติมก่อนส่งใหม่', 422);
      const changed = await tx.company.updateMany({ where: { id: before.id, version: before.version, status: 'NEED_MORE_INFO' },
        data: { status: 'PENDING', reviewNote: null, version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'สถานะบริษัทถูกเปลี่ยนแล้ว', 409);
      await this.event(tx, before, await tx.company.findUniqueOrThrow({ where: { id: before.id } }), userId, cid);
    });
  }

  async adminList(userId: string, query: CompanyQueryDto): Promise<Page<AdminCompanyListItem>> {
    await this.actor(userId, 'PLATFORM_ADMIN');
    const where: Prisma.CompanyWhereInput = query.status ? { status: query.status } : {};
    const [rows, total] = await Promise.all([
      this.db.company.findMany({ where, orderBy: { createdAt: 'desc' }, skip: (query.page - 1) * query.page_size, take: query.page_size }),
      this.db.company.count({ where }),
    ]);
    return { data: rows.map((c) => ({ id: c.id, name: c.name, registration_no: c.registrationNo, status: c.status, created_at: c.createdAt.toISOString() })),
      meta: { page: query.page, page_size: query.page_size, total } };
  }

  async adminDetail(userId: string, companyId: string): Promise<AdminCompanyDetail> {
    await this.actor(userId, 'PLATFORM_ADMIN');
    const company = await this.db.company.findUnique({ where: { id: companyId }, include: { members: { include: { user: true } } } });
    if (!company) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
    return { ...this.response(company), email_domain: company.emailDomain, documents: await this.documentsFor(companyId),
      members: company.members.map((m) => ({ user_id: m.userId, full_name: m.user.fullName, email: m.user.email,
        member_role: m.memberRole, joined_at: m.joinedAt.toISOString() })) };
  }

  private async verifyCriteria(tx: Prisma.TransactionClient, company: Company): Promise<void> {
    const owner = await tx.companyMember.findFirst({ where: { companyId: company.id, memberRole: 'OWNER' }, include: { user: true } });
    const cert = await tx.companyDocument.count({ where: { companyId: company.id, docType: 'REGISTRATION_CERT' } });
    if (!company.registrationNo || !cert || (!company.website && !company.phone) || !owner || !owner.user.emailVerifiedAt ||
        owner.user.status !== 'ACTIVE' || owner.user.email.split('@')[1]?.toLowerCase() !== company.emailDomain.toLowerCase()) {
      throw new AppException('COMPANY_REQUIREMENTS_INCOMPLETE', 'ข้อมูลหรือเอกสารบริษัทไม่ครบตามเกณฑ์', 422);
    }
  }

  async adminAction(userId: string, companyId: string, action: string, reason?: string, id?: string): Promise<void> {
    await this.actor(userId, 'PLATFORM_ADMIN');
    const transitions: Record<string, { from: CompanyStatus; to: CompanyStatus }> = {
      verify: { from: 'PENDING', to: 'VERIFIED' }, 'need-more-info': { from: 'PENDING', to: 'NEED_MORE_INFO' },
      reject: { from: 'PENDING', to: 'REJECTED' }, suspend: { from: 'VERIFIED', to: 'SUSPENDED' },
      unsuspend: { from: 'SUSPENDED', to: 'VERIFIED' },
    };
    const transition = transitions[action];
    if (!transition) throw new AppException('NOT_FOUND', 'ไม่พบ action นี้', 404);
    const note = reason?.trim();
    if (['need-more-info', 'reject', 'suspend'].includes(action) && !note) throw new AppException('VALIDATION_ERROR', 'ต้องระบุเหตุผล', 400);
    const cid = correlation(id);
    await this.db.$transaction(async (tx) => {
      const before = await tx.company.findUnique({ where: { id: companyId } });
      if (!before) throw new AppException('NOT_FOUND', 'ไม่พบบริษัท', 404);
      if (before.status !== transition.from) throw new AppException('STATE_CONFLICT', 'สถานะบริษัทไม่รองรับการดำเนินการนี้', 409);
      if (action === 'verify') await this.verifyCriteria(tx, before);
      const changed = await tx.company.updateMany({ where: { id: companyId, status: transition.from, version: before.version },
        data: { status: transition.to, reviewNote: note ?? null, version: { increment: 1 } } });
      if (changed.count !== 1) throw new AppException('STATE_CONFLICT', 'สถานะบริษัทถูกเปลี่ยนแล้ว', 409);
      const after = await tx.company.findUniqueOrThrow({ where: { id: companyId } });
      await this.event(tx, before, after, userId, cid, note);
      if (action === 'suspend' || action === 'unsuspend') await this.suspendMembers(tx, companyId, userId, action === 'suspend', cid);
      await tx.adminAuditLog.create({ data: { adminId: userId, action: `COMPANY_${action.replaceAll('-', '_').toUpperCase()}`,
        targetType: 'COMPANY', targetId: companyId, before: { status: before.status }, after: { status: after.status },
        reason: note ?? null, correlationId: cid, occurredAt: new Date() } });
    });
  }

  private async suspendMembers(tx: Prisma.TransactionClient, companyId: string, adminId: string, suspended: boolean, cid: string): Promise<void> {
    const members = await tx.companyMember.findMany({ where: { companyId }, include: { user: true } });
    const reason = `COMPANY_SUSPENDED:${companyId}`;
    for (const member of members) {
      const before = member.user;
      if (suspended ? before.status !== 'ACTIVE' : before.status !== 'SUSPENDED' || before.suspendedReason !== reason) continue;
      const status = suspended ? 'SUSPENDED' : 'ACTIVE';
      const updated = await tx.user.updateMany({ where: { id: before.id, status: before.status, version: before.version },
        data: { status, suspendedReason: suspended ? reason : null, version: { increment: 1 } } });
      if (updated.count !== 1) throw new AppException('STATE_CONFLICT', 'สถานะสมาชิกบริษัทถูกเปลี่ยนแล้ว', 409);
      if (suspended) await tx.tokenDenylist.upsert({ where: { userId: before.id }, create: { userId: before.id, reason }, update: { reason } });
      else await tx.tokenDenylist.deleteMany({ where: { userId: before.id, reason } });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: before.id, fromStatus: before.status, toStatus: status,
        actorId: adminId, actorRole: 'PLATFORM_ADMIN', reason, correlationId: cid, occurredAt: new Date() } });
      await this.outbox.add(tx, { type: 'UserSuspended', aggregateId: before.id, correlationId: cid,
        payload: { user_id: before.id, suspended, reason, entity_version: before.version + 1, at: new Date().toISOString() } });
    }
  }
}
