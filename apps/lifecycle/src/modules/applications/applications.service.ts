import { randomUUID } from 'node:crypto';
import { AppException, OutboxWriter, asUuid, isUuid } from '@internpath/common';
import type {
  ApplicationEligibilityResponse,
  ApplicationStatus,
  ConsentCheckResponse,
  InternalJobResponse,
  Paginated,
  StudentApplicationDetail,
  StudentApplicationItem,
} from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import type { Application } from '../../../generated/client';
import {
  APPLICATION_STATUS_CHANGED,
  buildApplicationStatusChanged,
} from '../../events/producers/application-status-changed';
import { IdentityInternalClient } from '../../internal/identity-client.service';
import { JobInternalClient } from '../../internal/job-client.service';
import { PrismaService } from '../../prisma/prisma.service';
import type { Tx } from '../../prisma/types';
import { ApplicationStateMachine } from '../../state-machine/application-state-machine.service';
import { alreadyApplied, applicationNotFound, mapApplicationUniqueViolation } from '../../state-machine/errors';
import { ReapplyPolicy } from '../../state-machine/reapply-policy';
import { StatusHistoryWriter, type Actor } from '../../state-machine/status-history.writer';
import { INACTIVE_STATUSES, type UserTrigger } from '../../state-machine/transition-table';
import { loadSnapshotNames, toStudentDetail, toStudentItem } from './application-view';
import type { CreateApplicationDto } from './applications.dto';
import {
  assertJobOpen,
  blockedReasonError,
  companyNotVerified,
  computeMajorMismatch,
  consentRequired,
  resourceNotFound,
  studentBlockedReason,
} from './apply-rules';

/** action ของนักศึกษาที่เป็นการเปลี่ยนสถานะตรง (api-contract §7.2) — `dispute-fail` แยกเพราะต้องเขียน `fail_disputes` */
export type StudentTransitionAction = Extract<
  UserTrigger,
  'confirm-offer' | 'decline-offer' | 'withdraw' | 'request-termination'
>;

/**
 * ใบสมัครฝั่งนักศึกษา (api-contract §7.2, README §5.2, data-schema §8.1)
 * - ทุก endpoint กรองด้วย `student_user_id = sub` ที่ Service เอง (README §5.7) — ไม่ใช่ของตน ⇒ 404 (ไม่บอกว่ามีอยู่)
 * - การเปลี่ยนสถานะทั้งหมดผ่าน `ApplicationStateMachine` (Transaction + status_history + outbox E08)
 */
@Injectable()
export class ApplicationsService {
  constructor(
    private readonly db: PrismaService,
    private readonly identity: IdentityInternalClient,
    private readonly job: JobInternalClient,
    private readonly stateMachine: ApplicationStateMachine,
    private readonly reapply: ReapplyPolicy,
    private readonly history: StatusHistoryWriter,
    private readonly outbox: OutboxWriter,
  ) {}

  // ---------- POST /applications ----------

  /**
   * สร้างใบสมัคร `— → PENDING` (data-schema §8.1) — ลำดับการตรวจ:
   * consent ในคำขอ → อีเมล/อาจารย์ (Identity) → ผ่านวิชาแล้ว → เรซูเม่ของตน → ประกาศเปิดรับ (Job สด)
   * → บริษัท `VERIFIED` (`company_snapshots`) → Consent ที่ Identity → ไม่สมัครซ้ำ → Transaction
   */
  async create(
    studentUserId: string,
    body: CreateApplicationDto,
    correlationId?: string,
    now = new Date(),
  ): Promise<StudentApplicationItem> {
    if (body.consent !== true) throw consentRequired('CONSENT_NOT_ACCEPTED');

    const student = await this.identity.getStudent(studentUserId, correlationId);
    const studentBlocked = studentBlockedReason(student);
    if (studentBlocked) throw blockedReasonError(studentBlocked);
    // ตรวจล่วงหน้าเพื่อให้ error ถูกต้องก่อนเรียก Service อื่น — ตรวจและใช้สิทธิ์ปลดล็อกจริงใน Transaction อีกรอบ
    if ((await this.reapply.check(this.db, studentUserId)).blocked) throw blockedReasonError('REAPPLY_BLOCKED');

    const resume = await this.db.resume.findFirst({
      where: { id: body.resume_id, studentUserId, deletedAt: null },
      select: { id: true },
    });
    if (!resume) throw resourceNotFound('resume_id', 'ไม่พบเรซูเม่');

    const job = await this.fetchJob(body.job_id, correlationId);
    assertJobOpen(job, now);

    const company = await this.db.companySnapshot.findUnique({
      where: { companyId: job.company_id },
      select: { status: true },
    });
    // ยังไม่มี snapshot (E05 มาไม่ถึง) ⇒ ไม่รู้สถานะบริษัท ถือว่าไม่ผ่าน (fail-closed — data-schema §8.2.2)
    if (company?.status !== 'VERIFIED') throw companyNotVerified();

    const consent = await this.identity.checkConsent(studentUserId, job.company_id, correlationId);
    if (!consent.has_consent) throw consentRequired('CONSENT_NOT_RECORDED');

    const duplicate = await this.db.application.count({
      where: { studentUserId, jobId: job.job_id, status: { notIn: [...INACTIVE_STATUSES] } },
    });
    if (duplicate > 0) throw alreadyApplied();

    const actor: Actor = { userId: studentUserId, role: 'STUDENT' };
    const cid = asUuid(correlationId);
    const created = await this.db.$transaction(async (tx) => {
      await this.reapply.assertAndConsume(tx, studentUserId, now);
      await fillJobSnapshotTitle(tx, job);
      let app: Application;
      try {
        app = await tx.application.create({
          data: {
            jobId: job.job_id,
            companyId: job.company_id,
            studentUserId,
            advisorUserId: student.advisor_id ?? null,
            resumeId: resume.id,
            // `consent_id?` ของ `consents/check` (PM ตัดสิน 2026-11-18) — ไม่มี/ไม่ใช่ uuid ⇒ `null` เหมือนเดิม
            resumeConsentId: consentIdOf(consent),
            coverLetter: body.cover_letter ? body.cover_letter : null,
            majorMismatch: computeMajorMismatch(student.major, job.target_majors),
            status: 'PENDING',
            statusChangedAt: now,
          },
        });
      } catch (error) {
        // สมัครพร้อมกันสองคำขอ ⇒ partial unique index `applications_no_duplicate_active_per_job` ชน
        throw mapApplicationUniqueViolation(error) ?? error;
      }
      await this.history.record(tx, {
        entity: 'APPLICATION',
        entityId: app.id,
        fromStatus: null,
        toStatus: 'PENDING',
        actor,
        correlationId: cid,
        occurredAt: now,
      });
      await this.outbox.add(tx, {
        type: APPLICATION_STATUS_CHANGED,
        aggregateId: app.id,
        correlationId: cid,
        // สร้างใบสมัคร ⇒ ไม่มี from_status (PM ตัดสิน 2026-11-18)
        payload: buildApplicationStatusChanged(app, null, actor, now),
      });
      return app;
    });

    return toStudentItem(created, await loadSnapshotNames(this.db, [created]));
  }

  // ---------- GET ----------

  async list(
    studentUserId: string,
    status: ApplicationStatus | undefined,
    page = 1,
    pageSize = 20,
  ): Promise<Paginated<StudentApplicationItem>> {
    const where = { studentUserId, ...(status ? { status } : {}) };
    const [rows, total] = await Promise.all([
      this.db.application.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.db.application.count({ where }),
    ]);
    const names = await loadSnapshotNames(this.db, rows);
    return { data: rows.map((row) => toStudentItem(row, names)), meta: { page, page_size: pageSize, total } };
  }

  /** GET /me/applications/{id} — Timeline จาก `status_history` + `available_actions[]` ของนักศึกษา */
  async detail(studentUserId: string, applicationId: string, now = new Date()): Promise<StudentApplicationDetail> {
    const app = await this.ownApplication(studentUserId, applicationId);
    const [names, history, actions] = await Promise.all([
      loadSnapshotNames(this.db, [app]),
      this.db.statusHistory.findMany({
        where: { entity: 'APPLICATION', entityId: app.id },
        orderBy: { occurredAt: 'asc' },
      }),
      this.stateMachine.availableActions(app, 'STUDENT', now),
    ]);
    return toStudentDetail(app, names, history, actions.available_actions);
  }

  /** GET /me/application-eligibility — เหตุผลเดียวกับ Guard ของ `POST /applications` ฝั่งนักศึกษา (ไม่ขึ้นกับประกาศ) */
  async eligibility(studentUserId: string, correlationId?: string): Promise<ApplicationEligibilityResponse> {
    const student = await this.identity.getStudent(studentUserId, correlationId);
    const blocked =
      studentBlockedReason(student) ??
      ((await this.reapply.check(this.db, studentUserId)).blocked ? 'REAPPLY_BLOCKED' : null);
    return blocked ? { can_apply: false, blocked_reason: blocked } : { can_apply: true };
  }

  // ---------- Actions ----------

  /**
   * `confirm-offer` / `decline-offer` / `withdraw` / `request-termination`
   * Guard/Cascade/โควตาอยู่ใน Transition Table — เช่น `confirm-offer` ⇒ ใบอื่นที่ `HR_ACCEPTED` → `STUDENT_DECLINED` + release
   * `withdraw` จาก `IN_PROGRESS` ไม่มีในตาราง ⇒ `409 STATE_CONFLICT` (ต้องใช้ `request-termination`)
   */
  async transition(
    studentUserId: string,
    applicationId: string,
    action: StudentTransitionAction,
    reason: string | undefined,
    correlationId?: string,
  ): Promise<StudentApplicationDetail> {
    await this.ownApplication(studentUserId, applicationId);
    await this.stateMachine.execute(applicationId, {
      trigger: action,
      actor: { userId: studentUserId, role: 'STUDENT' },
      reason,
      correlationId: correlationId ?? randomUUID(),
    });
    return this.detail(studentUserId, applicationId);
  }

  /**
   * `dispute-fail` — ภายใน `evaluated_at + 7 วัน` (`422 DISPUTE_WINDOW_CLOSED`), 1 ครั้งต่อผลประเมิน 1 รอบ
   * คำโต้แย้งเก็บใน `fail_disputes` ใน Transaction เดียวกัน — **ไม่ใส่ใน status_history/E08** (อาจมีข้อมูลส่วนตัว)
   */
  async disputeFail(
    studentUserId: string,
    applicationId: string,
    statement: string,
    correlationId?: string,
  ): Promise<StudentApplicationDetail> {
    await this.ownApplication(studentUserId, applicationId);
    await this.stateMachine.execute(applicationId, {
      trigger: 'dispute-fail',
      actor: { userId: studentUserId, role: 'STUDENT' },
      correlationId: correlationId ?? randomUUID(),
      afterTransition: async (tx, after) => {
        await tx.failDispute.create({ data: { applicationId: after.id, statement, createdBy: studentUserId } });
      },
    });
    return this.detail(studentUserId, applicationId);
  }

  // ---------- helper ----------

  private async ownApplication(studentUserId: string, applicationId: string): Promise<Application> {
    const app = await this.db.application.findFirst({ where: { id: applicationId, studentUserId } });
    if (!app) throw applicationNotFound();
    return app;
  }

  /** ข้อมูลสดของประกาศจาก Job — ไม่มีประกาศ ⇒ `404` (field `job_id`); Job ล่ม ⇒ `502` ต่อ (fail-closed) */
  private async fetchJob(jobId: string, correlationId?: string): Promise<InternalJobResponse> {
    try {
      return await this.job.getJob(jobId, correlationId);
    } catch (error) {
      if (error instanceof AppException && error.getStatus() === 404) {
        throw resourceNotFound('job_id', 'ไม่พบประกาศงาน');
      }
      throw error;
    }
  }
}

/** `consent_id` ที่ Identity คืนเมื่อมี Consent — ค่าผิดรูปไม่ทำให้สมัครล้ม (คอลัมน์เป็น uuid) แค่ไม่ผูก */
function consentIdOf(consent: ConsentCheckResponse): string | null {
  return typeof consent.consent_id === 'string' && isUuid(consent.consent_id) ? consent.consent_id : null;
}

/**
 * เติม `job_snapshots.title` จาก `job_title` ของ Job (api-contract §10 — E03 ไม่มีชื่อประกาศ, PM ตัดสิน 2026-11-18)
 * - เติมเฉพาะเมื่อชื่อยังว่าง (snapshot ที่ E03 สร้าง) — ไม่เขียนทับชื่อเดิม
 * - ยังไม่มี snapshot ⇒ สร้างแถว `entity_version = 0` (placeholder แบบเดียวกับ Consumer E03) ให้ E03 ถัดไปเขียนทับสถานะได้เสมอ
 * - Job ยังไม่ส่ง `job_title` (ว่าง/ไม่มี) ⇒ ไม่ทำอะไร
 * - อ่านแบบไม่ล็อกก่อน: มีชื่อแล้ว (กรณีส่วนใหญ่) ⇒ ไม่เขียน — `ON CONFLICT DO UPDATE` ล็อกแถวแม้ `WHERE` ไม่ผ่าน
 *   จะทำให้การสมัครประกาศเดียวกันและ Consumer E03 ต้องรอกันทุกครั้ง
 */
async function fillJobSnapshotTitle(tx: Tx, job: InternalJobResponse): Promise<void> {
  const title = typeof job.job_title === 'string' ? job.job_title.trim() : '';
  if (!title) return;
  const current = await tx.jobSnapshot.findUnique({ where: { jobId: job.job_id }, select: { title: true } });
  if (current && current.title !== '') return;
  await tx.$executeRaw`
    INSERT INTO job_snapshots (job_id, company_id, status, title, entity_version, updated_at)
    VALUES (${job.job_id}::uuid, ${job.company_id}::uuid, ${job.status}::job_status, ${title}, 0, now())
    ON CONFLICT (job_id) DO UPDATE SET title = EXCLUDED.title, updated_at = now() WHERE job_snapshots.title = ''`;
}
