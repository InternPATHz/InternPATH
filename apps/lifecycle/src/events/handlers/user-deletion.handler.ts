import type { EventEnvelope, UserDeletionRequestedPayload } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { S3StorageService } from '../../common/storage/s3-storage.service';
import type { Tx } from '../../prisma/types';
import { ApplicationStateMachine } from '../../state-machine/application-state-machine.service';
import {
  ApplicationTransitionService,
  lockStudentApplications,
  type PendingQuotaEffect,
} from '../../state-machine/application-transition.service';
import { QuotaService, collectQuotaEffects } from '../../state-machine/quota.service';
import { StatusHistoryWriter, SYSTEM_ACTOR } from '../../state-machine/status-history.writer';
import { DELETION_BLOCKING_STATUSES } from '../../state-machine/transition-table';
import type { ApplicationStatus } from '../../../generated/client';
import { REVIEW_SUBMITTED } from '../producers/review-events';
import { invalid, optionalUuid, requireTimestamp, requireUuid } from './handler-support';

const TYPE = 'UserDeletionRequested';

/** ใบที่ยังไม่เริ่มฝึก ⇒ `cancel-by-deletion` (transition-table) + คืนโควตา */
export const CANCELLABLE_ON_DELETION: readonly ApplicationStatus[] = Object.freeze([
  'PENDING',
  'HR_ACCEPTED',
  'ADVISOR_PENDING',
  'ADVISOR_APPROVED',
]);

/** ชื่อผู้ถือใบรับรองหลังลบบัญชี (data-schema §6 `holder_name_snapshot`) */
export const DELETED_HOLDER_NAME = 'ผู้ใช้ที่ลบบัญชีแล้ว';

/** เหตุผลใน status_history ของการเปลี่ยนสถานะเพราะลบบัญชี (รหัส ไม่ใช่ข้อความอิสระ) */
export const USER_DELETED_REASON = 'USER_DELETED';

/**
 * คอลัมน์ user id นอก history ที่แทนด้วย `anonymous_actor_id` (data-schema §2.3 ข้อ 3 — `UPDATE` ธรรมดาแบบเดียวกับ Job)
 * ใช้ raw SQL เพื่อไม่ให้ `@updatedAt` ของ Prisma เปลี่ยนเวลาของแถว • รายชื่อตายตัว (ไม่รับจากภายนอก) จึงใช้ `Prisma.raw` ได้
 */
export const ANONYMIZED_COLUMNS: ReadonlyArray<readonly [table: string, column: string]> = Object.freeze([
  ['applications', 'student_user_id'],
  ['applications', 'advisor_user_id'],
  ['evaluations', 'evaluated_by'],
  ['fail_disputes', 'created_by'],
  ['fail_disputes', 'decided_by'],
  ['certificates', 'student_user_id'],
  ['certificates', 'issued_by'],
  ['certificates', 'revoked_by'],
  ['reviews', 'student_user_id'],
  ['review_replies', 'replied_by'],
  ['problem_reports', 'student_user_id'],
  ['problem_reports', 'advisor_user_id'],
  ['problem_reports', 'acknowledged_by'],
  ['problem_reports', 'resolved_by'],
  ['reapply_unlocks', 'student_user_id'],
  ['reapply_unlocks', 'unlocked_by'],
  ['student_advisor_links', 'advisor_user_id'],
] as const);

export interface UserDeletionOutcome {
  cancelled: number;
  resumesDeleted: number;
  reviewsRemoved: number;
  certificatesAnonymized: number;
  certificateFilesDeleted: number;
  reviewEventsPurged: number;
  historyAnonymized: number;
  auditAnonymized: number;
}

/**
 * Consumer E15 `UserDeletionRequested` (identity → lifecycle) — README §5.11, data-schema §2.3 (PM ตัดสิน 2026-11-17)
 *
 * ทำทั้งหมดใน `tx` ของ Event (idempotent ผ่าน `processed_events` และรับซ้ำก็ไม่มีอะไรให้ทำแล้ว):
 * 1. ใบที่ยังไม่เริ่มฝึก (`CANCELLABLE_ON_DELETION`) ⇒ `CANCELLED` (`cancel-by-deletion`, SYSTEM) + คืนโควตา
 * 2. ลบไฟล์เรซูเม่และรูปโปรไฟล์ (`student_profiles.photo_key`) ใน Storage แล้วลบแถว `resumes`, `student_profiles`, `student_advisor_links` ของผู้ใช้ และล้าง `cover_letter`
 * 3. รีวิว `SUBMITTED`/`HELD` ⇒ `REMOVED` + ล้าง `title`/`body`; รีวิว `PUBLISHED` เก็บไว้แบบ `anonymous` (ไม่แตะสถิติ)
 * 3.1 ลบแถว Outbox ของ E09 (`ReviewSubmitted`) ของผู้ใช้ — มีเนื้อหารีวิวคู่กับ `student_user_id`
 * 4. ใบรับรองเก็บไว้ ชื่อ ⇒ "ผู้ใช้ที่ลบบัญชีแล้ว" และลบไฟล์ PDF (พิมพ์ชื่อจริง) ใน Storage
 * 5. คอลัมน์ user id (`ANONYMIZED_COLUMNS`) ⇒ `anonymous_actor_id`
 * 6. `status_history.actor_id` / `admin_audit_log.admin_id` ⇒ Authorized Anonymization (`set_config` เฉพาะ transaction นี้)
 * payload ผิดรูป ⇒ `InvalidMessageError` (dead-letter) • Storage ล้ม ⇒ throw (retry ทั้ง Event — ลบไฟล์ซ้ำได้)
 * ใบที่เริ่มฝึกแล้ว (`IN_PROGRESS`/`FAIL_DISPUTED`/`REEVALUATION_REQUESTED`) ไม่ควรมี (Identity ตรวจ `deletion-eligibility` ก่อน) — ถ้ามีจะ log และทำให้ไม่ระบุตัวตนตามปกติ
 */
@Injectable()
export class UserDeletionHandler {
  private readonly logger = new Logger(UserDeletionHandler.name);

  constructor(
    private readonly storage: S3StorageService,
    private readonly transitions: ApplicationTransitionService,
    private readonly quota: QuotaService,
    private readonly stateMachine: ApplicationStateMachine,
    private readonly history: StatusHistoryWriter,
  ) {}

  async handle(envelope: EventEnvelope<string, UserDeletionRequestedPayload>, tx: Tx): Promise<UserDeletionOutcome> {
    const p = envelope.payload ?? ({} as UserDeletionRequestedPayload);
    if (envelope.producer !== 'identity') invalid(TYPE, 'producer');
    if (p.mode !== 'DELETE_AND_ANONYMIZE') invalid(TYPE, 'mode');
    const userId = requireUuid(TYPE, 'user_id', p.user_id);
    const anonymousId = requireUuid(TYPE, 'anonymous_actor_id', p.anonymous_actor_id);
    if (userId.toLowerCase() === anonymousId.toLowerCase()) invalid(TYPE, 'anonymous_actor_id');
    if (typeof p.role !== 'string' || p.role.trim() === '') invalid(TYPE, 'role');
    optionalUuid(TYPE, 'company_id', p.company_id);
    requireTimestamp(TYPE, 'requested_at', p.requested_at);

    const now = new Date();
    const correlationId = envelope.correlation_id;

    // 6 (ตั้งก่อน) — มีผลเฉพาะ transaction นี้ (`is_local = true`)
    await tx.$queryRaw`
      SELECT set_config('internpath.anonymize', 'on', true) AS anonymize,
             set_config('internpath.anonymous_actor_id', ${anonymousId}, true) AS actor`;

    // 1. ยกเลิกใบที่ยังไม่เริ่มฝึก — รวม ADVISOR_PENDING/ADVISOR_APPROVED ที่เกิดจากการยืนยันข้อเสนอพร้อมกับขอลบ
    //    (Identity ตรวจ deletion-eligibility แล้ว แต่สถานะเปลี่ยนได้ก่อน E15 มาถึง — PM ตัดสิน 2026-11-25)
    await lockStudentApplications(tx, userId);
    const blocking = await tx.application.count({
      where: { studentUserId: userId, status: { in: DELETION_BLOCKING_STATUSES.filter((s) => !CANCELLABLE_ON_DELETION.includes(s)) } },
    });
    if (blocking) this.logger.warn(`E15: ผู้ใช้มีใบที่เริ่มฝึกแล้ว ${blocking} ใบ (ควรถูกปฏิเสธที่ Identity) — ทำให้ไม่ระบุตัวตนต่อ`);
    const config = await this.stateMachine.loadGuardConfig();
    const quota: PendingQuotaEffect[] = [];
    const cancellable = await tx.application.findMany({
      where: { studentUserId: userId, status: { in: [...CANCELLABLE_ON_DELETION] } },
      orderBy: { id: 'asc' },
    });
    for (const app of cancellable) {
      const outcome = await this.transitions.apply(
        tx,
        app,
        { trigger: 'cancel-by-deletion', actor: SYSTEM_ACTOR, reason: USER_DELETED_REASON, correlationId },
        now,
        config,
      );
      quota.push(...collectQuotaEffects(outcome));
    }

    // 2. ไฟล์ + PII — ลบไฟล์ก่อนลบแถว (ล้ม ⇒ throw ⇒ rollback ทั้งหมดแล้ว retry)
    const resumes = await tx.resume.findMany({ where: { studentUserId: userId }, select: { objectKey: true, deletedAt: true } });
    for (const resume of resumes) {
      if (!resume.deletedAt) await this.storage.delete(resume.objectKey);
    }
    const resumesDeleted = (await tx.resume.deleteMany({ where: { studentUserId: userId } })).count;
    // รูปโปรไฟล์ (B4 — PM 18 พ.ย.) ลบไฟล์ก่อนลบแถว `student_profiles` เหมือนเรซูเม่
    const profile = await tx.studentProfile.findUnique({ where: { userId }, select: { photoKey: true } });
    if (profile?.photoKey) await this.storage.delete(profile.photoKey);
    await tx.studentProfile.deleteMany({ where: { userId } });
    await tx.studentAdvisorLink.deleteMany({ where: { studentUserId: userId } });
    await tx.$executeRaw`
      UPDATE applications SET cover_letter = NULL, resume_id = NULL
      WHERE student_user_id = ${userId}::uuid AND (cover_letter IS NOT NULL OR resume_id IS NOT NULL)`;

    // 3. รีวิว
    const pendingReviews = await tx.review.findMany({
      where: { studentUserId: userId, status: { in: ['SUBMITTED', 'HELD'] } },
      select: { id: true, status: true },
    });
    for (const review of pendingReviews) {
      await tx.$executeRaw`
        UPDATE reviews SET status = 'REMOVED'::review_status, title = NULL, body = '' WHERE id = ${review.id}::uuid`;
      await this.history.record(tx, {
        entity: 'REVIEW',
        entityId: review.id,
        fromStatus: review.status,
        toStatus: 'REMOVED',
        actor: SYSTEM_ACTOR,
        reason: USER_DELETED_REASON,
        correlationId,
        occurredAt: now,
      });
    }
    await tx.$executeRaw`
      UPDATE reviews SET anonymous = true
      WHERE student_user_id = ${userId}::uuid AND status = 'PUBLISHED'::review_status AND anonymous = false`;

    // ลบสำเนาเนื้อหารีวิวที่ค้างใน Outbox (E09 เก็บ title/body คู่กับ student_user_id) ทั้งที่ส่งแล้วและยังไม่ส่ง
    // รีวิวที่ยังไม่เผยแพร่ถูก REMOVED ข้างบนแล้ว จึงไม่ต้องส่ง E09 ต่อ ส่วนที่เผยแพร่แล้ว Verification ได้รับไปแล้ว
    const reviewEventsPurged = await tx.$executeRaw`
      DELETE FROM outbox_events WHERE type = ${REVIEW_SUBMITTED} AND payload->>'student_user_id' = ${userId}`;

    // 4. ใบรับรอง — PDF ในพื้นที่จัดเก็บพิมพ์ชื่อจริงไว้ จึงลบไฟล์ (เจ้าของคนเดียวที่ดาวน์โหลดได้คือผู้ที่ลบบัญชี)
    //    หน้าตรวจสอบสาธารณะยังใช้ข้อมูลในฐานข้อมูลได้ตามปกติ • ลบซ้ำได้ (รับ E15 ซ้ำ/retry)
    const certificateFiles = await tx.certificate.findMany({ where: { studentUserId: userId }, select: { pdfObjectKey: true } });
    for (const certificate of certificateFiles) await this.storage.delete(certificate.pdfObjectKey);
    const certificatesAnonymized = await tx.$executeRaw`
      UPDATE certificates SET holder_name_snapshot = ${DELETED_HOLDER_NAME}
      WHERE student_user_id = ${userId}::uuid AND holder_name_snapshot <> ${DELETED_HOLDER_NAME}`;

    // 5. คอลัมน์ user id
    for (const [table, column] of ANONYMIZED_COLUMNS) {
      await tx.$executeRaw`
        UPDATE ${Prisma.raw(table)} SET ${Prisma.raw(column)} = ${anonymousId}::uuid
        WHERE ${Prisma.raw(column)} = ${userId}::uuid`;
    }

    // 6. ประวัติ (trigger อนุญาตเฉพาะ actor_id/admin_id → anonymous_actor_id)
    const historyAnonymized = (await tx.statusHistory.updateMany({ where: { actorId: userId }, data: { actorId: anonymousId } })).count;
    const auditAnonymized = (await tx.adminAuditLog.updateMany({ where: { adminId: userId }, data: { adminId: anonymousId } })).count;

    // คืนโควตาท้ายสุด (Job idempotent) — ล้ม ⇒ quota_reserved=false แล้ว Reconciliation คืนให้ ไม่ throw
    const failed = await this.quota.settle(quota, correlationId);
    if (failed.length) this.logger.warn(`E15 release โควตาไม่สำเร็จ ${failed.length} ใบ — รอ Reconciliation`);

    const outcome: UserDeletionOutcome = {
      cancelled: cancellable.length,
      resumesDeleted,
      reviewsRemoved: pendingReviews.length,
      certificatesAnonymized,
      certificateFilesDeleted: certificateFiles.length,
      reviewEventsPurged,
      historyAnonymized,
      auditAnonymized,
    };
    // log แค่จำนวน — ไม่ log user id ของผู้ที่ขอลบ
    this.logger.log(`E15 done ${JSON.stringify(outcome)}`);
    return outcome;
  }
}
