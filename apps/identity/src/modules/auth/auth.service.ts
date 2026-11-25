import { createHash, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, normalizePemKey } from '@internpath/common';
import type { AuthUser, JobCategory, LoginResponse, RegisterCompanyRequest } from '@internpath/contracts';
import * as jwt from 'jsonwebtoken';
import { Prisma, User, UserStatus } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthMailer } from './auth.mailer';
import { RegisterAdvisorDto } from './auth.dto';
import { hashPassword, verifyPassword } from './password-hash';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const LOGIN_UNLOCK_TTL_MS = 15 * 60 * 1000;
/** อายุลิงก์คำเชิญนักศึกษาที่อาจารย์สร้าง (api-contract §4.1) */
export const STUDENT_INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
// Keep the Argon2id cost aligned with hashPassword so unknown emails take a comparable path.
const DUMMY_PASSWORD_HASH = '$argon2id$v=19$m=65536,t=3,p=1$+kLbPMU0/N0LgSirmYBc7g$ErFkD579AF6IBKfB8pjqV3N+TH1Wp1mvQRCLuQxLh/8';
const PUBLIC_DOMAINS = new Set(['gmail.com', 'googlemail.com', 'hotmail.com', 'outlook.com', 'live.com', 'yahoo.com', 'yahoo.co.th', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com', 'mail.com']);
const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');
const newToken = (): string => randomBytes(32).toString('base64url');
const normalizeEmail = (email: string): string => email.trim().toLowerCase();
const domainOf = (email: string): string => email.split('@')[1] ?? '';

function isUniqueError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

@Injectable()
export class AuthService {
  constructor(
    private readonly db: PrismaService,
    private readonly config: ConfigService,
    private readonly mailer: AuthMailer,
  ) {}

  private requireAcademic(email: string): string {
    const domain = domainOf(email);
    if (!domain.endsWith('.ac.th') || domain === 'ac.th') {
      throw new AppException('ACADEMIC_EMAIL_REQUIRED', 'ต้องใช้อีเมลสถาบันการศึกษา .ac.th', 400);
    }
    return domain;
  }

  /**
   * หา/สร้างมหาวิทยาลัยจากโดเมนอีเมล — ผู้สมัครคนแรกของโดเมนตั้งชื่อและตัวย่อ
   * โดเมนที่มีชื่อ/ตัวย่อแล้ว ใช้ของเดิม (ผู้สมัครคนหลังเปลี่ยนชื่อมหาวิทยาลัยไม่ได้)
   */
  private async university(tx: Prisma.TransactionClient, domain: string, name: string, abbreviation: string): Promise<{ id: string; abbreviation: string }> {
    const existing = await tx.university.findUnique({ where: { emailDomain: domain } });
    if (existing && !existing.active) throw new AppException('UNIVERSITY_INACTIVE', 'สถาบันนี้ยังไม่เปิดรับสมัคร', 403);
    if (existing?.abbreviation) return { id: existing.id, abbreviation: existing.abbreviation };
    const taken = await tx.university.findFirst({ where: { abbreviation, NOT: { emailDomain: domain } }, select: { id: true } });
    if (taken) throw new AppException('STATE_CONFLICT', 'ตัวย่อนี้มีมหาวิทยาลัยอื่นใช้แล้ว', 409, [{ field: 'university_abbreviation', issue: 'UNIVERSITY_ABBREVIATION_TAKEN' }]);
    const saved = existing
      // โดเมนเดิมที่ระบบสร้างไว้ก่อนมีฟิลด์นี้ (ชื่อ = โดเมน) ⇒ ตั้งชื่อจริงให้ครั้งเดียว
      ? await tx.university.update({ where: { id: existing.id }, data: { abbreviation, ...(existing.name === domain ? { name } : {}) } })
      : await tx.university.create({ data: { emailDomain: domain, name, abbreviation } });
    return { id: saved.id, abbreviation };
  }

  /** ตัวย่อ + เลขสุ่ม 6 หลัก ที่ยังไม่มีอาจารย์คนไหนใช้ (ชนตอน commit ⇒ ผู้เรียกลองใหม่) */
  private async advisorCode(tx: Prisma.TransactionClient, abbreviation: string): Promise<string> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const code = `${abbreviation}${randomInt(0, 1_000_000).toString().padStart(6, '0')}`;
      if (!await tx.advisorProfile.findUnique({ where: { advisorCode: code }, select: { userId: true } })) return code;
    }
    throw new AppException('STATE_CONFLICT', 'สร้างรหัสอาจารย์ไม่สำเร็จ กรุณาลองใหม่', 409);
  }

  async issueEmailToken(tx: Prisma.TransactionClient, userId: string, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD' | 'LOGIN_UNLOCK' | 'STUDENT_INVITATION'): Promise<string> {
    const token = newToken();
    await tx.emailToken.create({ data: {
      userId, purpose, tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + (purpose === 'VERIFY_EMAIL' ? VERIFY_TTL_MS
        : purpose === 'RESET_PASSWORD' ? RESET_TTL_MS : purpose === 'STUDENT_INVITATION' ? STUDENT_INVITATION_TTL_MS : LOGIN_UNLOCK_TTL_MS)),
    } });
    return token;
  }

  /** สมัครอาจารย์เท่านั้น — นักศึกษาไม่สมัครเอง (อาจารย์สร้างบัญชีให้ ปรับ 2026-11-21) */
  private async registerAdvisorUser(email: string, password: string, fullName: string, profile: RegisterAdvisorDto): Promise<void> {
    const normalized = normalizeEmail(email);
    const domain = this.requireAcademic(normalized);
    const passwordHash = await hashPassword(password);
    let token: string | undefined;
    for (let attempt = 0; !token; attempt += 1) {
      try {
        token = await this.db.$transaction(async (tx) => {
          const university = await this.university(tx, domain, profile.university_name, profile.university_abbreviation);
          const user = await tx.user.create({ data: {
            email: normalized, passwordHash, fullName: fullName.trim(), role: 'ADVISOR', universityId: university.id,
            advisorProfile: { create: { department: profile.department, advisorCode: await this.advisorCode(tx, university.abbreviation) } },
            consents: { create: { type: 'PRIVACY_POLICY', policyVersion: 'v1' } },
          } });
          return this.issueEmailToken(tx, user.id, 'VERIFY_EMAIL');
        });
      } catch (error) {
        const target = JSON.stringify((error as Prisma.PrismaClientKnownRequestError)?.meta?.target ?? '');
        // คำขอพร้อมกันได้รหัสอาจารย์/ตัวย่อชนกัน ⇒ ลองใหม่ (ไม่ใช่อีเมลซ้ำ)
        if (isUniqueError(error) && /advisor_?code|abbreviation|email_?domain/i.test(target) && attempt < 3) continue;
        if (isUniqueError(error) && /abbreviation/i.test(target)) {
          throw new AppException('STATE_CONFLICT', 'ตัวย่อนี้มีมหาวิทยาลัยอื่นใช้แล้ว', 409, [{ field: 'university_abbreviation', issue: 'UNIVERSITY_ABBREVIATION_TAKEN' }]);
        }
        if (isUniqueError(error)) throw new AppException('ACCOUNT_EXISTS', 'อีเมลนี้ลงทะเบียนแล้ว', 409);
        throw error;
      }
    }
    try { await this.mailer.send(normalized, 'verify-email', token); }
    catch { /* The account is committed; do not report registration as failed. */ }
  }

  registerAdvisor(body: RegisterAdvisorDto): Promise<void> {
    return this.registerAdvisorUser(body.email, body.password, body.full_name, body);
  }

  /**
   * นักศึกษาที่อาจารย์สร้างตั้งรหัสผ่านจากลิงก์คำเชิญ (`POST /auth/student-invitations/accept`): ใช้ครั้งเดียว อายุ 7 วัน
   * ตั้งรหัสผ่าน ยืนยันอีเมล และเปิดใช้บัญชี (`ACTIVE`) ในขั้นตอนเดียว; ผิด/หมดอายุ/ใช้แล้ว ⇒ 400 VALIDATION_FAILED (INVALID_TOKEN)
   */
  async acceptStudentInvitation(token: string, password: string): Promise<void> {
    const invalid = () => new AppException('VALIDATION_FAILED', 'ลิงก์คำเชิญไม่ถูกต้อง หมดอายุ หรือถูกใช้แล้ว', 400, [{ field: 'token', issue: 'INVALID_TOKEN' }]);
    const tokenHash = hashToken(token);
    // กันคำขอสุ่มจากสาธารณะก่อนคำนวณ Argon2id ที่หนัก
    const probe = await this.db.emailToken.findUnique({ where: { tokenHash } });
    if (!probe || probe.purpose !== 'STUDENT_INVITATION' || probe.usedAt || probe.expiresAt <= new Date()) throw invalid();
    const passwordHash = await hashPassword(password);
    await this.db.$transaction(async (tx) => {
      const record = await tx.emailToken.findUnique({ where: { tokenHash }, include: { user: true } });
      if (!record || record.purpose !== 'STUDENT_INVITATION' || record.usedAt || record.expiresAt <= new Date()) throw invalid();
      const consumed = await tx.emailToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw invalid();
      const user = record.user;
      if (user.role !== 'STUDENT' || user.status !== 'PENDING_EMAIL' || user.passwordHash !== null) throw invalid();
      const updated = await tx.user.updateMany({ where: { id: user.id, status: 'PENDING_EMAIL', passwordHash: null },
        data: { passwordHash, status: 'ACTIVE', emailVerifiedAt: new Date(), version: { increment: 1 } } });
      if (updated.count !== 1) throw invalid();
      await tx.consent.create({ data: { userId: user.id, type: 'PRIVACY_POLICY', policyVersion: 'v1' } });
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: user.id, fromStatus: 'PENDING_EMAIL', toStatus: 'ACTIVE',
        actorId: user.id, actorRole: 'STUDENT', reason: 'STUDENT_INVITATION_ACCEPTED', correlationId: randomUUID() } });
    });
  }

  async registerCompany(body: RegisterCompanyRequest): Promise<void> {
    const email = normalizeEmail(body.user.email);
    const domain = domainOf(email);
    if (PUBLIC_DOMAINS.has(domain)) throw new AppException('PUBLIC_EMAIL_NOT_ALLOWED', 'ต้องใช้อีเมลองค์กร', 400);
    const passwordHash = await hashPassword(body.user.password);
    let token: string;
    try {
      token = await this.db.$transaction(async (tx) => {
        const user = await tx.user.create({ data: {
          email, passwordHash, fullName: body.user.full_name.trim(), role: 'COMPANY_HR',
          consents: { create: { type: 'PRIVACY_POLICY', policyVersion: 'v1' } },
        } });
        await tx.company.create({ data: {
          name: body.company.name.trim(), registrationNo: body.company.registration_no.trim(),
          emailDomain: domain, website: body.company.website, phone: body.company.phone,
          members: { create: { userId: user.id, memberRole: 'OWNER' } },
        } });
        return this.issueEmailToken(tx, user.id, 'VERIFY_EMAIL');
      });
    } catch (error) {
      if (isUniqueError(error)) throw new AppException('ACCOUNT_OR_COMPANY_EXISTS', 'อีเมลหรือเลขทะเบียนนี้มีในระบบแล้ว', 409);
      throw error;
    }
    try { await this.mailer.send(email, 'verify-email', token); }
    catch { /* The account is committed; do not report registration as failed. */ }
  }

  async verifyEmail(token: string): Promise<void> {
    const tokenHash = hashToken(token);
    await this.db.$transaction(async (tx) => {
      const record = await tx.emailToken.findUnique({ where: { tokenHash }, include: { user: true } });
      if (!record || record.purpose !== 'VERIFY_EMAIL' || record.usedAt || record.expiresAt <= new Date()) {
        throw new AppException('INVALID_TOKEN', 'ลิงก์ยืนยันอีเมลไม่ถูกต้องหรือหมดอายุ', 400);
      }
      const consumed = await tx.emailToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw new AppException('INVALID_TOKEN', 'ลิงก์นี้ถูกใช้แล้ว', 400);
      if (record.user.status !== 'PENDING_EMAIL') throw new AppException('STATE_CONFLICT', 'สถานะบัญชีเปลี่ยนแล้ว', 409);
      const nextStatus: UserStatus = record.user.role === 'ADVISOR' ? 'PENDING_APPROVAL' : 'ACTIVE';
      const updated = await tx.user.updateMany({ where: { id: record.userId, status: 'PENDING_EMAIL' }, data: { status: nextStatus, emailVerifiedAt: new Date(), version: { increment: 1 } } });
      if (updated.count !== 1) throw new AppException('STATE_CONFLICT', 'สถานะบัญชีเปลี่ยนแล้ว', 409);
      await tx.statusHistory.create({ data: { entity: 'USER', entityId: record.userId, fromStatus: 'PENDING_EMAIL', toStatus: nextStatus, actorId: record.userId, actorRole: record.user.role, correlationId: randomUUID() } });
    });
  }

  async resendVerification(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user || user.status !== 'PENDING_EMAIL') return;
    const recent = await this.db.emailToken.findFirst({ where: { userId: user.id, purpose: 'VERIFY_EMAIL', createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent) return;
    const token = await this.db.$transaction((tx) => this.issueEmailToken(tx, user.id, 'VERIFY_EMAIL'));
    try { await this.mailer.send(email, 'verify-email', token); } catch { /* Same response for known and unknown accounts. */ }
  }

  private assertUsable(user: User): void {
    if (user.status === 'PENDING_EMAIL' || !user.emailVerifiedAt) throw new AppException('EMAIL_NOT_VERIFIED', 'กรุณายืนยันอีเมลก่อน', 401);
    if (user.status === 'PENDING_APPROVAL') throw new AppException('ACCOUNT_PENDING_APPROVAL', 'บัญชีกำลังรออนุมัติ', 403);
    if (user.status === 'SUSPENDED' || user.status === 'DELETED') throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ไม่สามารถใช้งานได้', 401);
  }

  private authUser(user: User): AuthUser {
    return { id: user.id, email: user.email, full_name: user.fullName, ...(user.phone ? { phone: user.phone } : {}), role: user.role, status: user.status, email_verified: !!user.emailVerifiedAt, created_at: user.createdAt.toISOString() };
  }

  private accessTtl(): number {
    const ttl = Number(this.config.get<string>('JWT_ACCESS_TTL_SECONDS') ?? 900);
    return Number.isInteger(ttl) && ttl > 0 ? ttl : 900;
  }

  private accessToken(user: User, companyId?: string, companyRole?: 'OWNER' | 'MEMBER', advisorId?: string, companyCategories?: JobCategory[]): string {
    const privateKey = normalizePemKey(this.config.get<string>('JWT_PRIVATE_KEY'));
    if (!privateKey) throw new AppException('AUTH_NOT_CONFIGURED', 'ระบบยังไม่ได้ตั้งค่า JWT_PRIVATE_KEY', 500);
    return jwt.sign({ role: user.role, ...(companyId ? { company_id: companyId, company_role: companyRole } : {}), ...(companyRole === 'MEMBER' ? { company_categories: companyCategories ?? [] } : {}), ...(advisorId ? { advisor_id: advisorId } : {}), ...(user.universityId ? { university_id: user.universityId } : {}) }, privateKey, { algorithm: 'RS256', subject: user.id, jwtid: randomUUID(), expiresIn: this.accessTtl() });
  }

  private async issueSession(user: User, familyId: string = randomUUID(), db: Prisma.TransactionClient = this.db): Promise<LoginResponse> {
    const [member, student] = await Promise.all([
      user.role === 'COMPANY_HR' ? db.companyMember.findUnique({ where: { userId: user.id } }) : null,
      user.role === 'STUDENT' ? db.studentProfileIdentity.findUnique({ where: { userId: user.id } }) : null,
    ]);
    const access_token = this.accessToken(user, member?.companyId, member?.memberRole, student?.advisorId ?? undefined, member?.categories);
    const refresh_token = newToken();
    await db.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refresh_token), familyId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) } });
    return { access_token, refresh_token, expires_in: this.accessTtl(), user: this.authUser(user) };
  }

  async login(emailInput: string, password: string, unlockToken?: string): Promise<LoginResponse> {
    let user = await this.db.user.findUnique({ where: { email: normalizeEmail(emailInput) } });
    if (!user) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    let unlockTokenId: string | undefined;
    if (unlockToken) {
      const tokenHash = hashToken(unlockToken);
      const record = await this.db.emailToken.findUnique({ where: { tokenHash } });
      if (!record || record.userId !== user.id || record.purpose !== 'LOGIN_UNLOCK' || record.usedAt ||
        record.expiresAt <= new Date()) throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
      unlockTokenId = record.id;
    } else if (user.lockedUntil && user.lockedUntil > new Date()) {
      throw new AppException('ACCOUNT_LOCKED', 'บัญชีถูกล็อกชั่วคราว', 429);
    }
    if (user.lockedUntil && user.lockedUntil <= new Date()) {
      user = await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    }
    // บัญชีที่ยังไม่ตั้งรหัสผ่าน (นักศึกษาที่อาจารย์สร้าง) เข้าสู่ระบบไม่ได้: ตอบเหมือนรหัสผ่านผิดและใช้เวลาใกล้เคียงกัน
    // แต่ไม่นับครั้งที่ผิด/ไม่ล็อกบัญชี (ผู้ไม่หวังดีล็อกบัญชีที่ยังไม่ถูกเปิดใช้ไม่ได้)
    if (user.passwordHash === null) {
      await verifyPassword(DUMMY_PASSWORD_HASH, password);
      throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const failed = await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } } });
      if (failed.failedLoginCount >= 5) {
        await this.db.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + LOCK_MS) } });
      }
      throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    this.assertUsable(user);
    if (unlockTokenId) {
      const consumed = await this.db.emailToken.updateMany({ where: { id: unlockTokenId, userId: user.id,
        purpose: 'LOGIN_UNLOCK', usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    return this.issueSession(user);
  }

  async requestLoginUnlock(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user || user.status !== 'ACTIVE' || !user.emailVerifiedAt || !user.lockedUntil ||
      user.lockedUntil <= new Date()) return;
    const token = await this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${user.id}::uuid FOR UPDATE`;
      const current = await tx.user.findUnique({ where: { id: user.id } });
      if (!current?.lockedUntil || current.lockedUntil <= new Date()) return undefined;
      const active = await tx.emailToken.findFirst({ where: { userId: user.id, purpose: 'LOGIN_UNLOCK',
        usedAt: null, expiresAt: { gt: new Date() } } });
      if (active) return undefined;
      const recent = await tx.emailToken.findFirst({ where: { userId: user.id, purpose: 'LOGIN_UNLOCK',
        createdAt: { gt: new Date(Date.now() - 60_000) } } });
      if (recent) return undefined;
      return this.issueEmailToken(tx, user.id, 'LOGIN_UNLOCK');
    });
    if (!token) return;
    try { await this.mailer.send(email, 'unlock-login', token); }
    catch {
      await this.db.emailToken.update({ where: { tokenHash: hashToken(token) }, data: { usedAt: new Date() } })
        .catch(() => undefined);
    }
  }

  async refresh(token: string): Promise<LoginResponse> {
    const tokenHash = hashToken(token);
    const found = await this.db.refreshToken.findUnique({ where: { tokenHash } });
    if (!found || found.expiresAt <= new Date() || found.revokedAt) throw new AppException('INVALID_REFRESH_TOKEN', 'Refresh Token ไม่ถูกต้อง', 401);
    if (found.rotatedAt) {
      await this.db.refreshToken.updateMany({ where: { familyId: found.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new AppException('REFRESH_TOKEN_REUSED', 'Refresh Token นี้ถูกใช้ซ้ำ', 401);
    }
    // ล็อกแถวผู้ใช้ก่อนหมุน token: การรีเซ็ตรหัสผ่าน/ระงับบัญชีที่ทำพร้อมกันจะรอกันเป็นลำดับ
    // ถ้าอีกฝั่งเพิกถอนไปก่อน ตรงนี้จะเห็น `revokedAt`; ถ้าตรงนี้ไปก่อน token ใหม่จะถูกเพิกถอนตามด้วย ไม่หลุดรอด
    return this.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${found.userId}::uuid FOR UPDATE`;
      const record = await tx.refreshToken.findUnique({ where: { tokenHash }, include: { user: true } });
      if (!record || record.expiresAt <= new Date() || record.revokedAt || record.rotatedAt) {
        throw new AppException('INVALID_REFRESH_TOKEN', 'Refresh Token ไม่ถูกต้อง', 401);
      }
      this.assertUsable(record.user);
      const updated = await tx.refreshToken.updateMany({ where: { id: record.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } });
      if (updated.count !== 1) throw new AppException('INVALID_REFRESH_TOKEN', 'Refresh Token ไม่ถูกต้อง', 401);
      return this.issueSession(record.user, record.familyId, tx);
    });
  }

  async logout(userId: string, token: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { userId, tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async forgotPassword(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.db.user.findUnique({ where: { email } });
    // บัญชีที่ยังไม่เคยตั้งรหัสผ่าน (นักศึกษาที่อาจารย์สร้าง) ต้องใช้ลิงก์คำเชิญ ไม่ใช่รีเซ็ตรหัสผ่าน
    if (!user || user.status === 'DELETED' || user.passwordHash === null) return;
    const recent = await this.db.emailToken.findFirst({ where: { userId: user.id, purpose: 'RESET_PASSWORD', createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent) return;
    const token = await this.db.$transaction((tx) => this.issueEmailToken(tx, user.id, 'RESET_PASSWORD'));
    try { await this.mailer.send(email, 'reset-password', token); } catch { /* Response must not reveal account existence. */ }
  }

  async resetPassword(token: string, password: string): Promise<void> {
    const passwordHash = await hashPassword(password);
    await this.db.$transaction(async (tx) => {
      const record = await tx.emailToken.findUnique({ where: { tokenHash: hashToken(token) } });
      if (!record || record.purpose !== 'RESET_PASSWORD' || record.usedAt || record.expiresAt <= new Date()) throw new AppException('INVALID_TOKEN', 'ลิงก์รีเซ็ตรหัสผ่านไม่ถูกต้องหรือหมดอายุ', 400);
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${record.userId}::uuid FOR UPDATE`;
      const now = new Date();
      const consumed = await tx.emailToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: now } }, data: { usedAt: now } });
      if (consumed.count !== 1) throw new AppException('INVALID_TOKEN', 'ลิงก์นี้ถูกใช้แล้ว', 400);
      // ลิงก์รีเซ็ตใบอื่นที่ออกไว้ก่อนหน้าและยังไม่หมดอายุต้องใช้ไม่ได้อีก (กันคนที่ได้อีเมลเก่าไปเปลี่ยนรหัสทับ)
      await tx.emailToken.updateMany({ where: { userId: record.userId, purpose: 'RESET_PASSWORD', usedAt: null }, data: { usedAt: now } });
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null, version: { increment: 1 } } });
      await tx.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: now } });
    });
  }
}
