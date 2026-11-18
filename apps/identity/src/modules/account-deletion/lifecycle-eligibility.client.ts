import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, signServiceToken } from '@internpath/common';
import type { DeletionEligibility } from './account-deletion.service';

/** secret ที่ใช้เซ็น token ไป Lifecycle — ชื่อเดียวกับที่ Lifecycle ตรวจ (api-contract §9, `.env.example`) */
export const LIFECYCLE_SECRET_ENV = 'LIFECYCLE_SERVICE_SECRET_IDENTITY';
export const LIFECYCLE_URL_ENV = 'LIFECYCLE_URL';
const DEFAULT_LIFECYCLE_URL = 'http://localhost:3004';
const TIMEOUT_MS = 5000;

interface EligibilityResponse {
  eligible: boolean;
  blocking_application_count: number;
}

const unavailable = () => new AppException('UPSTREAM_UNAVAILABLE', 'ยังตรวจสถานะใบสมัครไม่ได้ ลองใหม่ภายหลัง', 503);

/**
 * ถาม Lifecycle ว่าลบบัญชีได้ไหม — `GET /internal/v1/users/{user_id}/deletion-eligibility` (api-contract §9)
 * - `eligible=false` ⇒ `422 DELETION_BLOCKED` (มีใบสมัครที่ยังดำเนินอยู่)
 * - เรียกไม่สำเร็จทุกกรณี (ไม่ได้ตั้ง secret, Lifecycle ล่ม/ช้า, ตอบผิดรูป) ⇒ `503 UPSTREAM_UNAVAILABLE`
 *   **ปฏิเสธไว้ก่อน ไม่ปล่อยผ่าน** (fail-closed — PM ตัดสิน 2026-11-17)
 */
@Injectable()
export class LifecycleDeletionEligibility implements DeletionEligibility {
  private readonly log = new Logger(LifecycleDeletionEligibility.name);

  constructor(private readonly config: ConfigService) {}

  async assertNoActiveApplications(userId: string): Promise<void> {
    const result = await this.fetchEligibility(userId);
    if (!result.eligible) {
      throw new AppException('DELETION_BLOCKED', 'ยังมีใบสมัครฝึกงานที่ดำเนินอยู่ ลบบัญชีไม่ได้', 422, [
        { issue: 'ACTIVE_APPLICATION' },
      ]);
    }
  }

  private async fetchEligibility(userId: string): Promise<EligibilityResponse> {
    const secret = this.config.get<string>(LIFECYCLE_SECRET_ENV);
    if (!secret || secret.length < 32) {
      this.log.error(`${LIFECYCLE_SECRET_ENV} is missing or shorter than 32 characters — account deletion is refused`);
      throw unavailable();
    }
    const base = (this.config.get<string>(LIFECYCLE_URL_ENV) || DEFAULT_LIFECYCLE_URL).replace(/\/+$/, '');
    const token = signServiceToken({ issuer: 'identity', audience: 'lifecycle', secret });
    let response: Response;
    try {
      response = await fetch(`${base}/internal/v1/users/${encodeURIComponent(userId)}/deletion-eligibility`, {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.log.warn(`Lifecycle deletion-eligibility unreachable: ${(error as Error).name}`);
      throw unavailable();
    }
    if (response.status !== 200) {
      this.log.warn(`Lifecycle deletion-eligibility answered ${response.status}`);
      throw unavailable();
    }
    const body = (await response.json().catch(() => null)) as Partial<EligibilityResponse> | null;
    if (!body || typeof body.eligible !== 'boolean') {
      this.log.warn('Lifecycle deletion-eligibility answered an invalid body');
      throw unavailable();
    }
    return { eligible: body.eligible, blocking_application_count: Number(body.blocking_application_count ?? 0) };
  }
}
