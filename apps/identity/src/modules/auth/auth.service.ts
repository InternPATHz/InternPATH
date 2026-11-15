import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '@internpath/common';
import type { AuthUser, LoginResponse, RegisterCompanyRequest, RegisterStudentRequest } from '@internpath/contracts';
import * as jwt from 'jsonwebtoken';
import { Prisma, User, UserStatus } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { AuthMailer } from './auth.mailer';
import { RegisterAdvisorDto } from './auth.dto';
import { hashPassword, verifyPassword } from './password-hash';

const VERIFY_TTL_MS = 24 * 60 * 60 * 1000;
const RESET_TTL_MS = 30 * 60 * 1000;
const REFRESH_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const LOCK_MS = 15 * 60 * 1000;
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

  private async universityId(tx: Prisma.TransactionClient, domain: string): Promise<string> {
    const university = await tx.university.upsert({
      where: { emailDomain: domain },
      create: { emailDomain: domain, name: domain },
      update: {},
    });
    if (!university.active) throw new AppException('UNIVERSITY_INACTIVE', 'สถาบันนี้ยังไม่เปิดรับสมัคร', 403);
    return university.id;
  }

  private async issueEmailToken(tx: Prisma.TransactionClient, userId: string, purpose: 'VERIFY_EMAIL' | 'RESET_PASSWORD'): Promise<string> {
    const token = newToken();
    await tx.emailToken.create({ data: {
      userId, purpose, tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + (purpose === 'VERIFY_EMAIL' ? VERIFY_TTL_MS : RESET_TTL_MS)),
    } });
    return token;
  }

  private async registerUser(email: string, password: string, fullName: string, role: 'STUDENT' | 'ADVISOR', profile: RegisterStudentRequest | RegisterAdvisorDto): Promise<void> {
    const normalized = normalizeEmail(email);
    const domain = this.requireAcademic(normalized);
    const passwordHash = await hashPassword(password);
    let token: string;
    try {
      token = await this.db.$transaction(async (tx) => {
        const universityId = await this.universityId(tx, domain);
        const user = await tx.user.create({ data: {
          email: normalized, passwordHash, fullName: fullName.trim(), role, universityId,
          ...(role === 'STUDENT'
            ? { studentProfile: { create: {
                studentCode: (profile as RegisterStudentRequest).student_code,
                major: (profile as RegisterStudentRequest).major,
                yearLevel: (profile as RegisterStudentRequest).year_level,
              } } }
            : { advisorProfile: { create: { department: (profile as RegisterAdvisorDto).department } } }),
          consents: { create: { type: 'PRIVACY_POLICY', policyVersion: 'v1' } },
        } });
        return this.issueEmailToken(tx, user.id, 'VERIFY_EMAIL');
      });
    } catch (error) {
      if (isUniqueError(error)) throw new AppException('ACCOUNT_EXISTS', 'อีเมลนี้ลงทะเบียนแล้ว', 409);
      throw error;
    }
    try { await this.mailer.send(normalized, 'verify-email', token); }
    catch { /* The account is committed; do not report registration as failed. */ }
  }

  registerStudent(body: RegisterStudentRequest): Promise<void> {
    return this.registerUser(body.email, body.password, body.full_name, 'STUDENT', body);
  }

  registerAdvisor(body: RegisterAdvisorDto): Promise<void> {
    return this.registerUser(body.email, body.password, body.full_name, 'ADVISOR', body);
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
    if (user.status === 'PENDING_EMAIL' || !user.emailVerifiedAt) throw new AppException('EMAIL_NOT_VERIFIED', 'กรุณายืนยันอีเมลก่อน', 403);
    if (user.status === 'PENDING_APPROVAL') throw new AppException('ACCOUNT_PENDING_APPROVAL', 'บัญชีกำลังรออนุมัติ', 403);
    if (user.status === 'SUSPENDED' || user.status === 'DELETED') throw new AppException('ACCOUNT_SUSPENDED', 'บัญชีนี้ไม่สามารถใช้งานได้', 403);
  }

  private authUser(user: User): AuthUser {
    return { id: user.id, email: user.email, full_name: user.fullName, ...(user.phone ? { phone: user.phone } : {}), role: user.role, status: user.status, email_verified: !!user.emailVerifiedAt, created_at: user.createdAt.toISOString() };
  }

  private accessTtl(): number {
    const ttl = Number(this.config.get<string>('JWT_ACCESS_TTL_SECONDS') ?? 900);
    return Number.isInteger(ttl) && ttl > 0 ? ttl : 900;
  }

  private accessToken(user: User, companyId?: string, companyRole?: 'OWNER' | 'MEMBER', advisorId?: string): string {
    const privateKey = (this.config.get<string>('JWT_PRIVATE_KEY') ?? '').replace(/\\n/g, '\n');
    if (!privateKey) throw new AppException('AUTH_NOT_CONFIGURED', 'ระบบยังไม่ได้ตั้งค่า JWT_PRIVATE_KEY', 500);
    return jwt.sign({ role: user.role, ...(companyId ? { company_id: companyId, company_role: companyRole } : {}), ...(advisorId ? { advisor_id: advisorId } : {}), ...(user.universityId ? { university_id: user.universityId } : {}) }, privateKey, { algorithm: 'RS256', subject: user.id, jwtid: randomUUID(), expiresIn: this.accessTtl() });
  }

  private async issueSession(user: User, familyId: string = randomUUID()): Promise<LoginResponse> {
    const [member, student] = await Promise.all([
      user.role === 'COMPANY_HR' ? this.db.companyMember.findUnique({ where: { userId: user.id } }) : null,
      user.role === 'STUDENT' ? this.db.studentProfileIdentity.findUnique({ where: { userId: user.id } }) : null,
    ]);
    const access_token = this.accessToken(user, member?.companyId, member?.memberRole, student?.advisorId ?? undefined);
    const refresh_token = newToken();
    await this.db.refreshToken.create({ data: { userId: user.id, tokenHash: hashToken(refresh_token), familyId, expiresAt: new Date(Date.now() + REFRESH_TTL_MS) } });
    return { access_token, refresh_token, expires_in: this.accessTtl(), user: this.authUser(user) };
  }

  async login(emailInput: string, password: string): Promise<LoginResponse> {
    let user = await this.db.user.findUnique({ where: { email: normalizeEmail(emailInput) } });
    if (!user) throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    if (user.lockedUntil && user.lockedUntil > new Date()) throw new AppException('ACCOUNT_LOCKED', 'บัญชีถูกล็อกชั่วคราว', 429);
    if (user.lockedUntil) user = await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    const valid = await verifyPassword(user.passwordHash, password);
    if (!valid) {
      const failed = await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: { increment: 1 } } });
      if (failed.failedLoginCount >= 5) {
        await this.db.user.update({ where: { id: user.id }, data: { lockedUntil: new Date(Date.now() + LOCK_MS) } });
      }
      throw new AppException('INVALID_CREDENTIALS', 'อีเมลหรือรหัสผ่านไม่ถูกต้อง', 401);
    }
    this.assertUsable(user);
    await this.db.user.update({ where: { id: user.id }, data: { failedLoginCount: 0, lockedUntil: null } });
    return this.issueSession(user);
  }

  async refresh(token: string): Promise<LoginResponse> {
    const record = await this.db.refreshToken.findUnique({ where: { tokenHash: hashToken(token) }, include: { user: true } });
    if (!record || record.expiresAt <= new Date() || record.revokedAt) throw new AppException('INVALID_REFRESH_TOKEN', 'Refresh Token ไม่ถูกต้อง', 401);
    if (record.rotatedAt) {
      await this.db.refreshToken.updateMany({ where: { familyId: record.familyId, revokedAt: null }, data: { revokedAt: new Date() } });
      throw new AppException('REFRESH_TOKEN_REUSED', 'Refresh Token นี้ถูกใช้ซ้ำ', 401);
    }
    this.assertUsable(record.user);
    const updated = await this.db.refreshToken.updateMany({ where: { id: record.id, rotatedAt: null, revokedAt: null }, data: { rotatedAt: new Date() } });
    if (updated.count !== 1) throw new AppException('INVALID_REFRESH_TOKEN', 'Refresh Token ไม่ถูกต้อง', 401);
    return this.issueSession(record.user, record.familyId);
  }

  async logout(userId: string, token: string): Promise<void> {
    await this.db.refreshToken.updateMany({ where: { userId, tokenHash: hashToken(token), revokedAt: null }, data: { revokedAt: new Date() } });
  }

  async forgotPassword(emailInput: string): Promise<void> {
    const email = normalizeEmail(emailInput);
    const user = await this.db.user.findUnique({ where: { email } });
    if (!user || user.status === 'DELETED') return;
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
      const consumed = await tx.emailToken.updateMany({ where: { id: record.id, usedAt: null, expiresAt: { gt: new Date() } }, data: { usedAt: new Date() } });
      if (consumed.count !== 1) throw new AppException('INVALID_TOKEN', 'ลิงก์นี้ถูกใช้แล้ว', 400);
      await tx.user.update({ where: { id: record.userId }, data: { passwordHash, failedLoginCount: 0, lockedUntil: null, version: { increment: 1 } } });
      await tx.refreshToken.updateMany({ where: { userId: record.userId, revokedAt: null }, data: { revokedAt: new Date() } });
    });
  }
}
