import { Injectable, Logger } from '@nestjs/common';
import { JobInternalClient } from '../internal/job-client.service';
import type { PendingQuotaEffect, TransitionOutcome } from './application-transition.service';

/**
 * เรียก Internal API โควตาของ Job (api-contract §9) โดยใช้ `application_id` เป็น Idempotency Key
 *
 * ลำดับที่ใช้:
 * - `reserve` ก่อนเปิด Transaction (ต้องรู้ผล `QUOTA_FULL` ก่อนเปลี่ยนสถานะ) — ถ้า Transaction ล้ม ⇒ release ชดเชย
 * - `confirm`/`release` หลัง commit แบบ best-effort — ถ้าเรียกไม่สำเร็จ Job จะกระทบยอดผ่าน
 *   `POST /internal/v1/applications/reservation-check` ทุก 30 นาที โดย **Lifecycle เป็นฝ่ายชี้ขาด** (หัวข้อ 1.10)
 */
@Injectable()
export class QuotaService {
  private readonly log = new Logger(QuotaService.name);

  constructor(private readonly job: JobInternalClient) {}

  /** โยน error ของ Job ต่อ (เช่น `409 QUOTA_FULL`) */
  async reserve(jobId: string, applicationId: string, correlationId?: string): Promise<void> {
    await this.job.reserveQuota(jobId, applicationId, correlationId);
  }

  /** release ชดเชยเมื่อ Transaction หลัง reserve ล้มเหลว — ไม่โยน error ทับ error เดิม */
  async compensate(jobId: string, applicationId: string, correlationId?: string): Promise<void> {
    await this.settle([{ effect: 'RELEASE', jobId, applicationId, reason: 'TRANSITION_FAILED' }], correlationId);
  }

  /** เรียก confirm/release หลัง commit — คืนรายการที่ล้มเหลว (ให้ Reconciliation แก้ภายหลัง) */
  async settle(effects: readonly PendingQuotaEffect[], correlationId?: string): Promise<PendingQuotaEffect[]> {
    const failed: PendingQuotaEffect[] = [];
    for (const effect of effects) {
      try {
        if (effect.effect === 'CONFIRM') {
          await this.job.confirmQuota(effect.jobId, effect.applicationId, correlationId);
        } else {
          await this.job.releaseQuota(effect.jobId, effect.applicationId, effect.reason, correlationId);
        }
      } catch (error) {
        failed.push(effect);
        // log เฉพาะ id และรหัส error — ไม่ log ข้อความจากปลายทาง
        this.log.warn(
          {
            application_id: effect.applicationId,
            job_id: effect.jobId,
            effect: effect.effect,
            code: (error as { code?: string }).code ?? 'UNKNOWN',
          },
          'Quota call failed after commit; left for reservation-check reconciliation',
        );
      }
    }
    return failed;
  }
}

/** รวมผลโควตาของใบหลักและใบที่ถูก Cascade */
export function collectQuotaEffects(outcome: Pick<TransitionOutcome, 'quota' | 'cascaded'>): PendingQuotaEffect[] {
  return [...outcome.quota, ...outcome.cascaded.flatMap((c) => collectQuotaEffects(c))];
}
