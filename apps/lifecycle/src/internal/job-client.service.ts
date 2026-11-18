import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException, signServiceToken } from '@internpath/common';
import type {
  InternalJobResponse,
  QuotaApplicationRequest,
  QuotaReleaseRequest,
  QuotaReserveResponse,
} from '@internpath/contracts';
import { fetchInternal } from './internal-http.client';

/**
 * ชื่อตัวแปร env สำหรับ secret ที่ใช้ลงนาม Service Token ไปยัง Job Service
 * ชั่วคราวใช้ชื่อ JOB_SERVICE_SECRET_LIFECYCLE (รอ PM/Junior ยืนยัน)
 */
export const JOB_SERVICE_SECRET_ENV = 'JOB_SERVICE_SECRET_LIFECYCLE';

@Injectable()
export class JobInternalClient {
  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return this.config.get<string>('JOB_URL', 'http://localhost:3002');
  }

  private getServiceToken(): string {
    const secret = this.config.get<string>(JOB_SERVICE_SECRET_ENV);
    if (!secret || secret.length < 32) {
      throw new AppException(
        'AUTH_NOT_CONFIGURED',
        `${JOB_SERVICE_SECRET_ENV} is not configured or shorter than 32 characters`,
        500,
      );
    }
    return signServiceToken({
      issuer: 'lifecycle',
      audience: 'job',
      secret,
    });
  }

  async reserveQuota(jobId: string, applicationId: string, correlationId?: string): Promise<QuotaReserveResponse> {
    const url = `${this.baseUrl}/internal/v1/jobs/${jobId}/quota/reserve`;
    const body: QuotaApplicationRequest = { application_id: applicationId };
    return fetchInternal<QuotaReserveResponse>(url, {
      method: 'POST',
      body,
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }

  async confirmQuota(jobId: string, applicationId: string, correlationId?: string): Promise<void> {
    const url = `${this.baseUrl}/internal/v1/jobs/${jobId}/quota/confirm`;
    const body: QuotaApplicationRequest = { application_id: applicationId };
    await fetchInternal<void>(url, {
      method: 'POST',
      body,
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }

  async releaseQuota(jobId: string, applicationId: string, reason: string, correlationId?: string): Promise<void> {
    const url = `${this.baseUrl}/internal/v1/jobs/${jobId}/quota/release`;
    const body: QuotaReleaseRequest = { application_id: applicationId, reason };
    await fetchInternal<void>(url, {
      method: 'POST',
      body,
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }

  /** GET /internal/v1/jobs/{job_id} (api-contract §9) — ใช้ยืนยันสถานะ/โควตา/deadline ตอนสมัคร */
  async getJob(jobId: string, correlationId?: string): Promise<InternalJobResponse> {
    const url = `${this.baseUrl}/internal/v1/jobs/${jobId}`;
    return fetchInternal<InternalJobResponse>(url, {
      method: 'GET',
      serviceToken: this.getServiceToken(),
      correlationId,
    });
  }
}
