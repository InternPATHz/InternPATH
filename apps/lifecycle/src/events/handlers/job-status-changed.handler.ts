import type { ApplicationEffect, EventEnvelope, JobStatus, JobStatusChangedPayload } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import { Prisma, JobStatus as PrismaJobStatus } from '../../../generated/client';
import type { Tx } from '../../prisma/types';
import { ApplicationTransitionService, type PendingQuotaEffect } from '../../state-machine/application-transition.service';
import { ApplicationStateMachine } from '../../state-machine/application-state-machine.service';
import { QuotaService, collectQuotaEffects } from '../../state-machine/quota.service';
import { SYSTEM_ACTOR } from '../../state-machine/status-history.writer';
import { FLAG_FOR_ADVISOR_STATUSES } from '../../state-machine/transition-table';
import {
  COMPANY_SUSPENDED,
  freezeApplications,
  optionalUuid,
  requireOneOf,
  requireTimestamp,
  requireUuid,
  requireVersion,
  unfreezeApplications,
} from './handler-support';

const TYPE = 'JobStatusChanged';
const JOB_STATUSES = Object.values(PrismaJobStatus) as JobStatus[];
const EFFECTS: readonly ApplicationEffect[] = ['FREEZE', 'UNFREEZE', 'CANCEL_PRE_APPROVAL', 'FLAG_POST_APPROVAL', 'NONE'];

/** ใบที่ยังไม่ถึง `ADVISOR_APPROVED` ⇒ `CANCELLED` (trigger `cancel-by-job` ของ State Machine) */
const CANCEL_STATUSES = ['PENDING', 'HR_ACCEPTED', 'ADVISOR_PENDING'] as const;

export type JobEventOutcome = 'applied' | 'stale';

/**
 * Consumer E03 `JobStatusChanged` (job → lifecycle) — README §5.1.2, event-contract E03, data-schema §8.2
 *
 * 1. ล็อก/เทียบ `job_snapshots.entity_version`: Event ที่ `entity_version` ≤ snapshot ⇒ **ข้ามทั้ง snapshot และ effect**
 *    (ลำดับสลับ เช่น REMOVE มาก่อน FREEZE ⇒ ไม่ Freeze ย้อนหลัง — PM 18 พ.ย.) ส่งซ้ำกันด้วย `processed_events` อีกชั้น
 * 2. `application_effect`: `FREEZE` / `UNFREEZE` (ไม่ปลดถ้าบริษัทยังถูกระงับ) / `CANCEL_PRE_APPROVAL`
 *    (ก่อน `ADVISOR_APPROVED` ⇒ `CANCELLED` + E08 + คืนโควตา; ตั้งแต่ `ADVISOR_APPROVED`/`IN_PROGRESS` ⇒ `flagged_for_advisor`) /
 *    `FLAG_POST_APPROVAL` (สงวน — ติดธงอย่างเดียว) / `NONE` ⇒ snapshot อย่างเดียว
 * 3. E03 ไม่มี `title`/`target_majors` ⇒ snapshot ที่ยังไม่มีสร้างด้วยชื่อว่าง และคงค่าเดิมเมื่อมีอยู่แล้ว —
 *    ชื่อเติมตอนสมัครจาก `job_title` ของ `GET /internal/v1/jobs/{id}` (`fillJobSnapshotTitle` — PM ตัดสิน 2026-11-18)
 */
@Injectable()
export class JobStatusChangedHandler {
  private readonly logger = new Logger(JobStatusChangedHandler.name);

  constructor(
    private readonly transitions: ApplicationTransitionService,
    private readonly quota: QuotaService,
    private readonly stateMachine: ApplicationStateMachine,
  ) {}

  async handle(envelope: EventEnvelope<string, JobStatusChangedPayload>, tx: Tx): Promise<JobEventOutcome> {
    const p = envelope.payload ?? ({} as JobStatusChangedPayload);
    const jobId = requireUuid(TYPE, 'job_id', p.job_id);
    const companyId = requireUuid(TYPE, 'company_id', p.company_id);
    const toStatus = requireOneOf(TYPE, 'to_status', p.to_status, JOB_STATUSES);
    const version = requireVersion(TYPE, p.entity_version);
    const changedAt = requireTimestamp(TYPE, 'changed_at', p.changed_at);
    const effect = p.application_effect === undefined ? 'NONE' : requireOneOf(TYPE, 'application_effect', p.application_effect, EFFECTS);
    optionalUuid(TYPE, 'submission_id', p.submission_id);

    // แถว placeholder (version 0) ให้ล็อกได้แม้ยังไม่มี snapshot — Event ของประกาศเดียวกันที่มาพร้อมกันรอกันตามลำดับ
    await tx.$executeRaw`
      INSERT INTO job_snapshots (job_id, company_id, status, title, entity_version, updated_at)
      VALUES (${jobId}::uuid, ${companyId}::uuid, ${toStatus}::job_status, '', 0, now())
      ON CONFLICT (job_id) DO NOTHING`;
    const [current] = await tx.$queryRaw<Array<{ entity_version: number }>>`
      SELECT entity_version FROM job_snapshots WHERE job_id = ${jobId}::uuid FOR UPDATE`;
    if (current.entity_version >= version) {
      this.logger.warn(`E03 ข้าม: entity_version ${version} ≤ snapshot ${current.entity_version} (job ${jobId})`);
      return 'stale';
    }
    await tx.jobSnapshot.update({
      where: { jobId },
      data: { companyId, status: toStatus, entityVersion: version },
    });

    const jobScope = Prisma.sql`a.job_id = ${jobId}::uuid`;
    switch (effect) {
      case 'FREEZE':
        await freezeApplications(tx, jobScope, changedAt);
        break;
      case 'UNFREEZE':
        await unfreezeApplications(tx, jobScope, changedAt, COMPANY_SUSPENDED);
        break;
      case 'CANCEL_PRE_APPROVAL':
        await this.cancelPreApproval(tx, jobId, toStatus, p.reason_code, envelope.correlation_id);
        await this.flagForAdvisor(tx, jobId);
        break;
      case 'FLAG_POST_APPROVAL':
        await this.flagForAdvisor(tx, jobId);
        break;
      default:
        break;
    }
    return 'applied';
  }

  private async cancelPreApproval(
    tx: Tx,
    jobId: string,
    toStatus: JobStatus,
    reasonCode: string | undefined,
    correlationId: string,
  ): Promise<void> {
    const now = new Date();
    const config = await this.stateMachine.loadGuardConfig();
    const targets = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM applications
      WHERE job_id = ${jobId}::uuid AND status::text IN (${Prisma.join([...CANCEL_STATUSES])})
      ORDER BY id FOR UPDATE`;
    const quota: PendingQuotaEffect[] = [];
    for (const { id } of targets) {
      const app = await tx.application.findUniqueOrThrow({ where: { id } });
      const outcome = await this.transitions.apply(
        tx,
        app,
        {
          trigger: 'cancel-by-job',
          actor: SYSTEM_ACTOR,
          // เหตุผลเป็นรหัส (ไม่ใช่ข้อความอิสระจาก Job) — ประกาศถูกตีกลับ/ระงับถาวร
          reason: `JOB_${toStatus}${reasonCode ? `:${reasonCode.slice(0, 50)}` : ''}`,
          correlationId,
        },
        now,
        config,
      );
      quota.push(...collectQuotaEffects(outcome));
    }
    // Job idempotent ด้วย application_id • ล้ม ⇒ ไม่ throw: quota_reserved=false แล้ว Reconciliation (reservation-check) คืนให้
    const failed = await this.quota.settle(quota, correlationId);
    if (failed.length) this.logger.warn(`E03 release โควตาไม่สำเร็จ ${failed.length} ใบ (job ${jobId}) — รอ Reconciliation`);
  }

  private async flagForAdvisor(tx: Tx, jobId: string): Promise<void> {
    await tx.application.updateMany({
      where: { jobId, status: { in: [...FLAG_FOR_ADVISOR_STATUSES] }, flaggedForAdvisor: false },
      data: { flaggedForAdvisor: true, version: { increment: 1 } },
    });
  }
}
