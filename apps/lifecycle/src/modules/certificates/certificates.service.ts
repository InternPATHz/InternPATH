import { createHash, randomUUID } from 'node:crypto';
import { AppException, OutboxWriter, asUuid, type JwtClaims } from '@internpath/common';
import type {
  ActorRole,
  CertificateDownloadResponse,
  CertificateItem,
  Paginated,
  PublicCertificateResponse,
} from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Certificate } from '../../../generated/client';
import { AUDIT_ACTIONS, recordAdminAudit } from '../../common/audit/admin-audit';
import { CategoryScopeService } from '../../common/auth/category-scope.service';
import { assertCompanyOwnership } from '../../common/auth/ownership';
import { S3StorageService } from '../../common/storage/s3-storage.service';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';
import {
  CERTIFICATE_ISSUED,
  CERTIFICATE_REVOKED,
  buildCertificateIssued,
  buildCertificateRevoked,
} from '../../events/producers/certificate-events';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Tx } from '../../prisma/types';
import { applicationNotFound, reasonRequired, stateConflict } from '../../state-machine/errors';
import { StatusHistoryWriter } from '../../state-machine/status-history.writer';
import { formatDate, loadSnapshotNames, toCertificateItem } from '../applications/application-view';
import { generateCertificateCode, isCertificateCode } from './certificate-code';
import { CertificatePdfRenderer } from './certificate-pdf.renderer';
import { certificateNotFound, checkCertificateIssuable, effectiveMinActualDays } from './certificate-rules';

type RevokerRole = Extract<ActorRole, 'COMPANY_HR' | 'PLATFORM_ADMIN'>;

/** ชื่อ action ใน `admin_audit_log` (README §5.10) — รายการทั้งหมดอยู่ที่ `AUDIT_ACTIONS` */
export const AUDIT_CERTIFICATE_REVOKE = AUDIT_ACTIONS.CERTIFICATE_REVOKE;

/** รหัสสุ่มชนกัน (โอกาสน้อยมาก) ⇒ สุ่มใหม่และสร้าง PDF ใหม่ได้กี่ครั้ง */
const CODE_ATTEMPTS = 3;

/**
 * E-Certificate (api-contract §7.3 `certificate`/`revoke`, §7.5, §7.7 `revoke`; README §5.4; data-schema §6)
 * - PDF สร้างจาก HTML ด้วย Chromium (ฟอนต์ไทยฝังในไฟล์) → SHA-256 → Private bucket (เข้าถึงผ่าน Signed URL เท่านั้น)
 * - ทุกการเปลี่ยนสถานะเขียน `status_history` (entity `CERTIFICATE`) + Outbox (E12/E13) ใน Transaction เดียว
 * - ชื่อผู้ถือดึงสดจาก Identity ตอนออก แล้วเก็บเป็น `holder_name_snapshot` ตาม data-schema §6
 *   (ข้อยกเว้นที่เอกสารกำหนดของกติกา "ห้ามเก็บ full_name" — ใบรับรองต้องคงชื่อตามวันที่ออก; ลบบัญชี ⇒ 1.11 แทนเป็น "ผู้ใช้ที่ลบบัญชีแล้ว")
 */
@Injectable()
export class CertificatesService {
  private readonly logger = new Logger(CertificatesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly identity: IdentityInternalClient,
    private readonly renderer: CertificatePdfRenderer,
    private readonly storage: S3StorageService,
    private readonly outbox: OutboxWriter,
    private readonly history: StatusHistoryWriter,
    private readonly config: LifecycleConfigService,
    private readonly scope: CategoryScopeService,
  ) {}

  // ---------- HR: ออกใบรับรอง ----------

  /**
   * `POST /hr/applications/{id}/certificate` → `201 CertificateItem`
   * ไม่มีใบ ⇒ 404 • บริษัทอื่น ⇒ 403 • ไม่ได้ PASS ⇒ 409 • ฝึกจริงไม่ถึง ⇒ 422 `CERT_MIN_ACTUAL_DAYS`
   * ออกแล้ว ⇒ 409 `STATE_CONFLICT` + `CERTIFICATE_ALREADY_ISSUED` (1 ใบต่อใบสมัคร — `application_id` unique แม้ถูกเพิกถอน)
   */
  async issue(user: JwtClaims, applicationId: string, correlationId?: string, now = new Date()): Promise<CertificateItem> {
    const cid = asUuid(correlationId ?? randomUUID());
    const app = await this.db.application.findUnique({ where: { id: applicationId } });
    if (!app) throw applicationNotFound();
    assertCompanyOwnership(user, app.companyId);
    await this.scope.assertInScope(user, app, correlationId);

    const minDays = await this.minActualDays();
    const eligibility = checkCertificateIssuable(app, await this.lastEvaluationResult(this.db, app.id), minDays);
    if ('error' in eligibility) throw eligibility.error;
    if (await this.db.certificate.findUnique({ where: { applicationId: app.id }, select: { id: true } })) {
      throw stateConflict('CERTIFICATE_ALREADY_ISSUED');
    }

    // ข้อมูลบนใบ: ชื่อประกาศ/บริษัทจาก snapshot ของ Lifecycle, ชื่อนักศึกษาจาก Identity (ล่ม ⇒ ออกไม่ได้ — fail-closed)
    const names = await loadSnapshotNames(this.db, [app]);
    const jobTitle = names.jobTitles.get(app.jobId);
    const companyName = names.companyNames.get(app.companyId);
    if (!jobTitle || !companyName) {
      throw new AppException('UPSTREAM_UNAVAILABLE', 'ยังไม่มีข้อมูลประกาศหรือบริษัทสำหรับออกใบรับรอง', 503, [
        { issue: !jobTitle ? 'JOB_SNAPSHOT_MISSING' : 'COMPANY_SNAPSHOT_MISSING' },
      ]);
    }
    const student = await this.identity.getStudent(app.studentUserId, cid);
    const holderName = student.full_name?.trim();
    if (!holderName) {
      throw new AppException('UPSTREAM_UNAVAILABLE', 'อ่านชื่อนักศึกษาไม่สำเร็จ', 503, [{ issue: 'HOLDER_NAME_MISSING' }]);
    }
    const periodStart = app.actualStartDate as Date;
    const periodEnd = app.actualEndDate as Date;

    for (let attempt = 1; ; attempt += 1) {
      const certificateCode = generateCertificateCode(now);
      const pdf = await this.renderPdf({
        certificateCode,
        holderName,
        companyName,
        jobTitle,
        periodStart,
        periodEnd,
        actualDays: eligibility.days,
        issuedAt: now,
      });
      const sha256 = createHash('sha256').update(pdf).digest('hex');
      const key = this.storage.generateKey('certificates', 'pdf');
      await this.storage.upload(key, pdf, 'application/pdf');

      try {
        const cert = await this.db.$transaction(async (tx) => {
          // ตรวจซ้ำใน Transaction — สถานะอาจเปลี่ยนระหว่างสร้าง PDF
          const fresh = await tx.application.findUniqueOrThrow({ where: { id: app.id } });
          const again = checkCertificateIssuable(fresh, await this.lastEvaluationResult(tx, fresh.id), minDays);
          if ('error' in again) throw again.error;

          const created = await tx.certificate.create({
            data: {
              certificateCode,
              applicationId: fresh.id,
              studentUserId: fresh.studentUserId,
              companyId: fresh.companyId,
              holderNameSnapshot: holderName,
              companyNameSnapshot: companyName,
              jobTitleSnapshot: jobTitle,
              periodStart,
              periodEnd,
              actualDays: eligibility.days,
              pdfObjectKey: key,
              pdfSha256: sha256,
              status: 'VALID',
              issuedBy: user.sub,
              issuedAt: now,
            },
          });
          await this.history.record(tx, {
            entity: 'CERTIFICATE',
            entityId: created.id,
            fromStatus: null,
            toStatus: 'VALID',
            actor: { userId: user.sub, role: 'COMPANY_HR' },
            correlationId: cid,
            occurredAt: now,
          });
          await this.outbox.add(tx, {
            type: CERTIFICATE_ISSUED,
            aggregateId: created.id,
            correlationId: cid,
            payload: buildCertificateIssued(created, user.sub, now),
          });
          return created;
        });
        return toCertificateItem(cert);
      } catch (error) {
        // ไม่มีแถวใน DB ⇒ ไฟล์ที่อัปโหลดไว้ไม่มีใครอ้างถึง ลบทิ้ง (ล้มก็แค่ log — ไม่บังผล error จริง)
        await this.storage.delete(key).catch(() => this.logger.warn('ลบไฟล์ PDF ใบรับรองที่ไม่ได้ใช้ไม่สำเร็จ'));
        const conflict = uniqueTarget(error);
        if (conflict === 'application_id') throw stateConflict('CERTIFICATE_ALREADY_ISSUED');
        if (conflict === 'certificate_code' && attempt < CODE_ATTEMPTS) continue;
        throw error;
      }
    }
  }

  // ---------- นักศึกษา ----------

  /** `GET /me/certificates` — ของตนเท่านั้น (รวมที่ถูกเพิกถอน เพื่อให้เห็นสถานะ) ใหม่สุดก่อน */
  async listMine(user: JwtClaims, page = 1, pageSize = 20): Promise<Paginated<CertificateItem>> {
    const where = { studentUserId: user.sub };
    const [rows, total] = await Promise.all([
      this.db.certificate.findMany({
        where,
        orderBy: [{ issuedAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.certificate.count({ where }),
    ]);
    return { data: rows.map(toCertificateItem), meta: { page, page_size: pageSize, total } };
  }

  /**
   * `GET /me/certificates/{id}/download` → Signed URL (~10 นาที) — ไฟล์เห็นได้เฉพาะเจ้าของ (README §5.11)
   * ไม่ใช่ของตน ⇒ 404 (ไม่บอกว่ามีอยู่) • ถูกเพิกถอน ⇒ `409 STATE_CONFLICT` + `CERTIFICATE_REVOKED` (ไม่แจกไฟล์ที่ใช้ไม่ได้แล้ว)
   */
  async download(user: JwtClaims, certificateId: string): Promise<CertificateDownloadResponse> {
    const cert = await this.db.certificate.findFirst({ where: { id: certificateId, studentUserId: user.sub } });
    if (!cert) throw certificateNotFound();
    if (cert.status !== 'VALID') throw stateConflict('CERTIFICATE_REVOKED');
    const ttl = await this.config.getNumber('SIGNED_URL_EXPIRES_SECONDS');
    const url = await this.storage.getSignedDownloadUrl(cert.pdfObjectKey, ttl);
    return { url, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  // ---------- เพิกถอน ----------

  /** `POST /hr/certificates/{id}/actions/revoke` — เฉพาะใบที่บริษัทตนออก (UAT-23 ข้อ 2: บริษัทอื่น ⇒ 403) */
  async revokeByHr(user: JwtClaims, certificateId: string, reason: string | undefined, correlationId?: string, now = new Date()) {
    const cert = await this.db.certificate.findUnique({ where: { id: certificateId } });
    if (!cert) throw certificateNotFound();
    assertCompanyOwnership(user, cert.companyId);
    return this.revoke(cert, user.sub, 'COMPANY_HR', reason, correlationId, now);
  }

  /** `POST /admin/lifecycle/certificates/{id}/actions/revoke` — ทุกใบ + `admin_audit_log` (README §5.10) */
  async revokeByAdmin(user: JwtClaims, certificateId: string, reason: string | undefined, correlationId?: string, now = new Date()) {
    const cert = await this.db.certificate.findUnique({ where: { id: certificateId } });
    if (!cert) throw certificateNotFound();
    return this.revoke(cert, user.sub, 'PLATFORM_ADMIN', reason, correlationId, now);
  }

  // ---------- สาธารณะ ----------

  /**
   * `GET /public/certificates/{code}` — ไม่ต้องล็อกอิน; แสดง **เฉพาะ** สถานะ ชื่อผู้ถือ บริษัท ตำแหน่ง ช่วงฝึก (README §5.4)
   * ไม่มีอีเมล/เบอร์/รหัสนักศึกษา/id ภายใน • รหัสรูปแบบผิดหรือไม่มีอยู่ ⇒ 404 รูปแบบเดียวกัน
   */
  async publicLookup(code: string): Promise<PublicCertificateResponse> {
    if (!isCertificateCode(code)) throw certificateNotFound();
    const cert = await this.db.certificate.findUnique({ where: { certificateCode: code } });
    if (!cert) throw certificateNotFound();
    return {
      status: cert.status,
      holder_name: cert.holderNameSnapshot,
      company_name: cert.companyNameSnapshot,
      job_title: cert.jobTitleSnapshot,
      period: { start: formatDate(cert.periodStart) as string, end: formatDate(cert.periodEnd) as string },
    };
  }

  // ---------- helper ----------

  private async revoke(
    cert: Certificate,
    actorId: string,
    role: RevokerRole,
    rawReason: string | undefined,
    correlationId: string | undefined,
    now: Date,
  ): Promise<CertificateItem> {
    const reason = rawReason?.trim();
    if (!reason) throw reasonRequired();
    const cid = asUuid(correlationId ?? randomUUID());

    const updated = await this.db.$transaction(async (tx) => {
      // ผู้ชนะ 1 ราย — เพิกถอนซ้ำ/พร้อมกัน ⇒ 409
      const { count } = await tx.certificate.updateMany({
        where: { id: cert.id, status: 'VALID' },
        data: { status: 'REVOKED', revokedBy: actorId, revokedByRole: role, revokeReason: reason, revokedAt: now },
      });
      if (count === 0) throw stateConflict('ALREADY_REVOKED');
      const after = await tx.certificate.findUniqueOrThrow({ where: { id: cert.id } });

      await this.history.record(tx, {
        entity: 'CERTIFICATE',
        entityId: cert.id,
        fromStatus: 'VALID',
        toStatus: 'REVOKED',
        actor: { userId: actorId, role },
        reason,
        correlationId: cid,
        occurredAt: now,
      });
      if (role === 'PLATFORM_ADMIN') {
        await recordAdminAudit(tx, {
          adminId: actorId,
          action: AUDIT_CERTIFICATE_REVOKE,
          targetType: 'CERTIFICATE',
          targetId: cert.id,
          before: { status: 'VALID' },
          after: { status: 'REVOKED' },
          reason,
          correlationId: cid,
          occurredAt: now,
        });
      }
      await this.outbox.add(tx, {
        type: CERTIFICATE_REVOKED,
        aggregateId: cert.id,
        correlationId: cid,
        payload: buildCertificateRevoked(after, actorId, role, reason, now),
      });
      return after;
    });
    return toCertificateItem(updated);
  }

  /**
   * สร้าง PDF ไม่สำเร็จ (เช่น ไม่มี Chromium) ⇒ `503 UPSTREAM_UNAVAILABLE` + `details[].issue = PDF_RENDER_FAILED`
   * ให้หน้าเว็บแสดงข้อความตรงเหตุแทน 500 ทั่วไป (PM ขอ 2026-11-18) • ไม่มีอะไรถูกเขียน (สร้าง PDF ก่อนอัปโหลด/Transaction)
   */
  private async renderPdf(input: Parameters<CertificatePdfRenderer['render']>[0]): Promise<Buffer> {
    try {
      return await this.renderer.render(input);
    } catch (error) {
      // ไม่ log ข้อความเต็ม (อาจมีชื่อผู้ถือใน stack ของ template)
      this.logger.error(`PDF render failed: ${(error as Error).name}`);
      throw new AppException('UPSTREAM_UNAVAILABLE', 'สร้างไฟล์ใบรับรองไม่สำเร็จ ลองใหม่ภายหลัง', 503, [{ issue: 'PDF_RENDER_FAILED' }]);
    }
  }

  private async minActualDays(): Promise<number> {
    return effectiveMinActualDays(await this.config.getNumber('CERT_MIN_ACTUAL_DAYS'));
  }

  private async lastEvaluationResult(db: Pick<Tx, 'evaluation'>, applicationId: string) {
    const last = await db.evaluation.findFirst({
      where: { applicationId },
      orderBy: [{ round: 'desc' }, { evaluatedAt: 'desc' }],
      select: { result: true },
    });
    return last?.result ?? null;
  }
}

/** P2002 ของ `certificates` ⇒ คอลัมน์ที่ชน (`application_id` / `certificate_code`) */
function uniqueTarget(error: unknown): 'application_id' | 'certificate_code' | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const e = error as { code?: unknown; message?: unknown; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return undefined;
  const target = e.meta?.target;
  const text = [Array.isArray(target) ? target.join(',') : String(target ?? ''), String(e.message ?? '')].join(' ');
  if (text.includes('application_id') || text.includes('applicationId')) return 'application_id';
  if (text.includes('certificate_code') || text.includes('certificateCode')) return 'certificate_code';
  return undefined;
}
