import { randomUUID } from 'node:crypto';
import { AppException } from '@internpath/common';
import type { InternalJobResponse } from '@internpath/contracts';

/**
 * Job Internal API ปลอม (หัวข้อ 1.4) — Job ยังไม่มี `internal/` จริง จึงจำลองตามชนิดใน @internpath/contracts
 * (api-contract §9: `GET /internal/v1/jobs/{id}`, `quota/reserve|confirm|release` แบบ idempotent ด้วย `application_id`)
 */
export class FakeJobClient {
  jobs = new Map<string, InternalJobResponse>();
  reserved = new Set<string>();
  calls: Array<{ op: 'reserve' | 'confirm' | 'release'; jobId: string; applicationId: string; reason?: string }> = [];
  unavailable = false;

  reset(): void {
    this.jobs.clear();
    this.reserved.clear();
    this.calls = [];
    this.unavailable = false;
  }

  addJob(data: Partial<InternalJobResponse> = {}): InternalJobResponse {
    const job: InternalJobResponse = {
      job_id: randomUUID(),
      company_id: randomUUID(),
      status: 'PUBLISHED',
      quota: 3,
      quota_available: 3,
      target_majors: [],
      application_deadline: '2099-12-31',
      entity_version: 1,
      ...data,
    };
    this.jobs.set(job.job_id, job);
    return job;
  }

  async getJob(jobId: string): Promise<InternalJobResponse> {
    if (this.unavailable) throw new AppException('UPSTREAM_UNAVAILABLE', 'job down', 502);
    const job = this.jobs.get(jobId);
    if (!job) throw new AppException('NOT_FOUND', 'job not found', 404);
    return { ...job, target_majors: [...job.target_majors] };
  }

  async reserveQuota(jobId: string, applicationId: string): Promise<{ reserved: true }> {
    this.calls.push({ op: 'reserve', jobId, applicationId });
    this.reserved.add(applicationId);
    return { reserved: true };
  }

  async confirmQuota(jobId: string, applicationId: string): Promise<void> {
    this.calls.push({ op: 'confirm', jobId, applicationId });
  }

  async releaseQuota(jobId: string, applicationId: string, reason: string): Promise<void> {
    this.calls.push({ op: 'release', jobId, applicationId, reason });
    this.reserved.delete(applicationId);
  }

  releasedFor(applicationId: string): boolean {
    return this.calls.some((c) => c.op === 'release' && c.applicationId === applicationId);
  }
}
