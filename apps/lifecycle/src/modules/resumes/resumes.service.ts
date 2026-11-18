import { Injectable, Logger } from '@nestjs/common';
import { AppException, type JwtClaims } from '@internpath/common';
import type { Paginated, ResumeItem, ResumeUrlResponse } from '@internpath/contracts';
import type { Prisma, Resume } from '../../../generated/client';
import { assertAdvisorOwnership, assertCompanyOwnership } from '../../common/auth/ownership';
import { S3StorageService } from '../../common/storage/s3-storage.service';
import { LifecycleConfigService } from '../../config/lifecycle-config.service';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RESUME_MIME, assertResumeFile, type UploadedResumeFile } from './resume-file';

/** prefix ของ Object Key ใน Private Bucket — ส่วนที่เหลือเป็น UUID สุ่ม (README §5.9) */
export const RESUME_KEY_PREFIX = 'resumes';

/** เพดานเรซูเม่ที่ยังไม่ลบต่อนักศึกษา (PM เสนอ 5 — รีวิว PR #37) */
export const MAX_ACTIVE_RESUMES = 5;

const notFound = () => new AppException('NOT_FOUND', 'ไม่พบเรซูเม่', 404);

/** HR/อาจารย์เปิดเรซูเม่ที่นักศึกษาลบแล้ว ⇒ 404 + issue ให้หน้าเว็บแยกจาก "ไม่พบ" (api-contract §2, §7.1) */
const deletedByStudent = () =>
  new AppException('NOT_FOUND', 'นักศึกษาลบเรซูเม่นี้แล้ว', 404, [{ field: 'resume', issue: 'RESUME_DELETED_BY_STUDENT' }]);

const limitReached = () =>
  new AppException('VALIDATION_FAILED', `มีเรซูเม่ได้ไม่เกิน ${MAX_ACTIVE_RESUMES} ไฟล์ — ลบไฟล์เดิมก่อน`, 400, [
    { field: 'file', issue: 'RESUME_LIMIT_REACHED' },
  ]);

/** ล็อกต่อนักศึกษาใน tx — upload()/remove() ใช้ตัวเดียวกัน กันไฟล์หลักซ้ำ/หาย และกันเกินเพดาน */
const lockStudent = (tx: Pick<Prisma.TransactionClient, '$executeRaw'>, studentUserId: string) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${studentUserId}))`;

/**
 * เรซูเม่ (api-contract §7.1, README §5.9 / §5.11)
 * - อัปโหลดผ่าน Lifecycle เท่านั้น เก็บใน Private Bucket; DB เก็บแค่ Object Key (ไม่ส่ง `object_key` ออกไป)
 * - ดาวน์โหลดผ่าน Signed URL (~10 นาที) ที่ออกหลังตรวจสิทธิ์แล้วเท่านั้น
 * - ห้าม log เนื้อหาไฟล์
 */
@Injectable()
export class ResumesService {
  private readonly logger = new Logger(ResumesService.name);

  constructor(
    private readonly db: PrismaService,
    private readonly storage: S3StorageService,
    private readonly config: LifecycleConfigService,
    private readonly identity: IdentityInternalClient,
  ) {}

  // ---------- นักศึกษา (/me/resumes) ----------

  /** POST /me/resumes — ตรวจไฟล์ → อัปโหลด → บันทึกแถว (ล้มหลังอัปโหลด ⇒ ลบไฟล์ชดเชย) */
  async upload(studentUserId: string, file: UploadedResumeFile | undefined): Promise<ResumeItem> {
    await assertResumeFile(file);
    // ตรวจเพดานก่อนอัปโหลด (ไม่ล็อก — แค่กันอัปโหลดเปล่า) แล้วตรวจซ้ำใต้ล็อกใน tx
    if ((await this.db.resume.count({ where: { studentUserId, deletedAt: null } })) >= MAX_ACTIVE_RESUMES) {
      throw limitReached();
    }
    const buffer = file!.buffer;
    const key = this.storage.generateKey(RESUME_KEY_PREFIX, 'pdf');
    await this.storage.upload(key, buffer, RESUME_MIME);

    let row: Resume;
    try {
      row = await this.db.$transaction(async (tx) => {
        // ล็อกต่อนักศึกษาใน tx นี้ กันอัปโหลดพร้อมกันแล้วได้ไฟล์หลัก 2 ไฟล์ / เกินเพดาน
        await lockStudent(tx, studentUserId);
        const active = await tx.resume.count({ where: { studentUserId, deletedAt: null } });
        if (active >= MAX_ACTIVE_RESUMES) throw limitReached();
        return tx.resume.create({
          data: {
            studentUserId,
            objectKey: key,
            mime: RESUME_MIME,
            sizeBytes: buffer.length,
            // เรซูเม่ไฟล์แรก (หรือไม่มีไฟล์อื่นเหลือ) เป็นไฟล์หลักอัตโนมัติ
            isPrimary: active === 0,
          },
        });
      });
    } catch (error) {
      await this.storage.delete(key).catch(() => {
        this.logger.warn('ลบไฟล์เรซูเม่ชดเชยไม่สำเร็จหลังบันทึก DB ล้มเหลว (ไฟล์กำพร้าใน Storage)');
      });
      throw error;
    }

    return this.toItem(row, await this.signedUrlTtl());
  }

  /** GET /me/resumes — เฉพาะที่ยังไม่ลบ เรียงไฟล์หลักก่อนแล้วใหม่สุดก่อน พร้อม Signed URL */
  async list(studentUserId: string, page = 1, pageSize = 20): Promise<Paginated<ResumeItem>> {
    const where = { studentUserId, deletedAt: null };
    const [rows, total] = await Promise.all([
      this.db.resume.findMany({
        where,
        orderBy: [{ isPrimary: 'desc' }, { uploadedAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.resume.count({ where }),
    ]);
    const ttl = await this.signedUrlTtl();
    const data = await Promise.all(rows.map((row) => this.toItem(row, ttl)));
    return { data, meta: { page, page_size: pageSize, total } };
  }

  /**
   * DELETE /me/resumes/{id} — ลบไฟล์ใน Storage ก่อน (README §5.11) แล้ว soft-delete แถว
   * ถ้าลบไฟล์หลัก ⇒ ตั้งไฟล์ที่อัปโหลดล่าสุดที่เหลือเป็นไฟล์หลัก
   * ไม่ใช่เจ้าของ/ไม่มี/ลบไปแล้ว ⇒ 404 (ไม่บอกว่ามีอยู่ — api-contract §2)
   */
  async remove(studentUserId: string, resumeId: string): Promise<void> {
    const resume = await this.db.resume.findFirst({ where: { id: resumeId, studentUserId, deletedAt: null } });
    if (!resume) throw notFound();

    // ลบไฟล์ก่อน: S3 DeleteObject เป็น idempotent — ถ้าล้มจะยังไม่ mark ลบ ผู้ใช้ลองใหม่ได้
    await this.storage.delete(resume.objectKey);

    await this.db.$transaction(async (tx) => {
      // ล็อกเดียวกับ upload(): ลบไฟล์หลักพร้อมอัปโหลด ⇒ ไม่จบที่ไม่มีไฟล์หลัก
      await lockStudent(tx, studentUserId);
      const marked = await tx.resume.updateMany({
        where: { id: resume.id, deletedAt: null },
        data: { deletedAt: new Date(), isPrimary: false },
      });
      if (marked.count === 0 || !resume.isPrimary) return;
      const next = await tx.resume.findFirst({
        where: { studentUserId, deletedAt: null },
        orderBy: { uploadedAt: 'desc' },
      });
      if (next) await tx.resume.update({ where: { id: next.id }, data: { isPrimary: true } });
    });
  }

  // ---------- HR / อาจารย์ (เรซูเม่ของใบสมัคร) ----------

  /**
   * GET /hr/applications/{id}/resume — เฉพาะ HR ของบริษัทที่นักศึกษาสมัคร **และมี Consent** (README §5.11)
   * บริษัทอื่น ⇒ 403 NOT_OWNER_OF_RESOURCE (UAT-29) • ไม่มี Consent ⇒ 403 CONSENT_REQUIRED
   */
  async forHr(user: JwtClaims, applicationId: string, correlationId?: string): Promise<ResumeUrlResponse> {
    const application = await this.findApplication(applicationId);
    assertCompanyOwnership(user, application.companyId);

    const resume = await this.activeResume(application.resumeId, application.studentUserId);
    const consent = await this.identity.checkConsent(application.studentUserId, application.companyId, correlationId);
    if (!consent.has_consent) {
      throw new AppException('CONSENT_REQUIRED', 'นักศึกษายังไม่ได้ให้ความยินยอมส่งเรซูเม่ให้บริษัทนี้', 403);
    }
    return this.signedUrl(resume);
  }

  /**
   * GET /advisor/applications/{id}/resume — เฉพาะอาจารย์ที่ผูกกับใบสมัคร (`advisor_user_id`)
   * นักศึกษานอกความดูแล ⇒ 403 NOT_OWNER_OF_RESOURCE (UAT-29)
   */
  async forAdvisor(user: JwtClaims, applicationId: string): Promise<ResumeUrlResponse> {
    const application = await this.findApplication(applicationId);
    assertAdvisorOwnership(user, application.advisorUserId);
    const resume = await this.activeResume(application.resumeId, application.studentUserId);
    return this.signedUrl(resume);
  }

  // ---------- helper ----------

  private async findApplication(applicationId: string) {
    const application = await this.db.application.findUnique({
      where: { id: applicationId },
      select: { id: true, companyId: true, studentUserId: true, advisorUserId: true, resumeId: true },
    });
    if (!application) throw new AppException('NOT_FOUND', 'ไม่พบใบสมัคร', 404);
    return application;
  }

  /**
   * เรซูเม่ของใบสมัครต้องเป็นของนักศึกษาเจ้าของใบสมัคร และยังไม่ถูกลบ (นักศึกษาลบได้ตาม README §5.11)
   * ลบแล้ว ⇒ 404 + `RESUME_DELETED_BY_STUDENT` • ไม่มี/ไม่ใช่ของเจ้าของใบสมัคร ⇒ 404 เฉยๆ
   */
  private async activeResume(resumeId: string | null, studentUserId: string): Promise<Resume> {
    if (!resumeId) throw notFound();
    const resume = await this.db.resume.findFirst({ where: { id: resumeId, studentUserId } });
    if (!resume) throw notFound();
    if (resume.deletedAt) throw deletedByStudent();
    return resume;
  }

  private async signedUrl(resume: Resume): Promise<ResumeUrlResponse> {
    const ttl = await this.signedUrlTtl();
    const url = await this.storage.getSignedDownloadUrl(resume.objectKey, ttl);
    return { url, expires_at: new Date(Date.now() + ttl * 1000).toISOString() };
  }

  private async toItem(row: Resume, ttl: number): Promise<ResumeItem> {
    return {
      id: row.id,
      size_bytes: row.sizeBytes,
      is_primary: row.isPrimary,
      url: await this.storage.getSignedDownloadUrl(row.objectKey, ttl),
      uploaded_at: row.uploadedAt.toISOString(),
    };
  }

  private signedUrlTtl(): Promise<number> {
    return this.config.getNumber('SIGNED_URL_EXPIRES_SECONDS');
  }
}
