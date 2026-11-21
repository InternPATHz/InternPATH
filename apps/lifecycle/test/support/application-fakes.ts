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
  /** ตั้งให้ `reserveQuota` ตอบ `409 QUOTA_FULL` (1.5 — HR ตอบรับเมื่อโควตาเต็ม) */
  quotaFull = false;

  /**
   * จำลองสถานะการจองของ Job ตาม api-contract §9 / #83 (เทสต์ QIR-01/03 ใช้) — ปิดไว้เป็นค่าเริ่มต้นเพื่อไม่กระทบเทสต์เดิม:
   * reserve ซ้ำขณะ RESERVED/CONFIRMED ⇒ 200 ไม่เปลี่ยน • หลัง RELEASED ⇒ จองใหม่ (หรือ QUOTA_FULL เมื่อเกิน `capacity`)
   * confirm ไม่มีการจอง/RELEASED ⇒ 409 STATE_CONFLICT • release ไม่มีการจอง ⇒ no-op
   */
  strict = false;
  reservations = new Map<string, 'RESERVED' | 'CONFIRMED' | 'RELEASED'>();
  /** จำนวนที่นั่งสูงสุดที่ `strict` ยอมให้ถือพร้อมกัน (RESERVED + CONFIRMED) — ไม่ตั้ง = ไม่จำกัด */
  capacity: number | undefined;
  /** ตั้งไว้ ⇒ `releaseQuota` รอให้ promise นี้จบก่อนมีผล (จำลอง release ที่ค้างบนเครือข่ายแล้วมาถึงทีหลัง) */
  releaseGate: Promise<void> | undefined;

  reset(): void {
    this.jobs.clear();
    this.reserved.clear();
    this.calls = [];
    this.unavailable = false;
    this.quotaFull = false;
    this.strict = false;
    this.reservations.clear();
    this.capacity = undefined;
    this.releaseGate = undefined;
  }

  private heldSeats(): number {
    return [...this.reservations.values()].filter((s) => s !== 'RELEASED').length;
  }

  addJob(data: Partial<InternalJobResponse> = {}): InternalJobResponse {
    const job: InternalJobResponse = {
      job_id: randomUUID(),
      company_id: randomUUID(),
      status: 'PUBLISHED',
      quota: 3,
      quota_available: 3,
      job_title: 'Test Job',
      category: 'TECH_IT',
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
    if (this.quotaFull) throw new AppException('QUOTA_FULL', 'โควตาเต็ม', 409);
    if (this.strict) {
      const current = this.reservations.get(applicationId);
      if (current === 'RESERVED' || current === 'CONFIRMED') return { reserved: true };
      if (this.capacity !== undefined && this.heldSeats() >= this.capacity) {
        throw new AppException('QUOTA_FULL', 'โควตาเต็ม', 409);
      }
      this.reservations.set(applicationId, 'RESERVED');
    }
    this.reserved.add(applicationId);
    return { reserved: true };
  }

  async confirmQuota(jobId: string, applicationId: string): Promise<void> {
    this.calls.push({ op: 'confirm', jobId, applicationId });
    if (this.strict) {
      const current = this.reservations.get(applicationId);
      if (current === undefined || current === 'RELEASED') {
        throw new AppException('STATE_CONFLICT', 'สถานะการจองโควตาไม่ตรงกับคำขอ', 409);
      }
      this.reservations.set(applicationId, 'CONFIRMED');
    }
  }

  async releaseQuota(jobId: string, applicationId: string, reason: string): Promise<void> {
    this.calls.push({ op: 'release', jobId, applicationId, reason });
    if (this.releaseGate) await this.releaseGate;
    if (this.strict && this.reservations.has(applicationId)) this.reservations.set(applicationId, 'RELEASED');
    this.reserved.delete(applicationId);
  }

  releasedFor(applicationId: string): boolean {
    return this.calls.some((c) => c.op === 'release' && c.applicationId === applicationId);
  }
}
