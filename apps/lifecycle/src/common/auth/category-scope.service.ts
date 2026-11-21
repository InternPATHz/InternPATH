import { AppException, type JwtClaims } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import type { JobCategory } from '../../../generated/client';
import { mapWithConcurrency } from '../async/concurrency';
import { JobInternalClient } from '../../internal/job-client.service';
import { PrismaService } from '../../prisma/prisma.service';

const CATEGORY_LOOKUP_CONCURRENCY = 5;

/**
 * สิทธิ์ตามสายงานของ HR Member (ปรับ Requirement 2026-11-21, README 5.6)
 * - Owner และ Admin เห็น/ทำได้ทุกสายงาน; HR Member เห็นเฉพาะใบสมัครของประกาศในสายงานที่ได้รับกำหนด (`company_categories` ใน JWT)
 * - สายงานของประกาศอ่านจาก `job_snapshots.category` (เติมจาก Internal job ตอนสมัคร); ยังว่าง ⇒ ถามจาก Job แล้วเติมให้
 * - ไม่มี `company_categories` ใน Token ของ Member ⇒ ถือว่าไม่มีสายงาน (ปิดไว้ก่อน — Fail-closed)
 */
@Injectable()
export class CategoryScopeService {
  constructor(
    private readonly db: PrismaService,
    private readonly job: JobInternalClient,
  ) {}

  /** `null` = ไม่จำกัดสายงาน */
  scopeOf(user: JwtClaims): JobCategory[] | null {
    if (user.role !== 'COMPANY_HR' || user.company_role !== 'MEMBER') return null;
    return [...(user.company_categories ?? [])];
  }

  /** สายงานของประกาศ — snapshot ที่ยังว่างถามจาก Job แล้วเติมให้ (Job ล่ม ⇒ ส่งต่อข้อผิดพลาดของ Internal API) */
  async categoryOf(jobId: string, correlationId?: string): Promise<JobCategory | null> {
    const snapshot = await this.db.jobSnapshot.findUnique({ where: { jobId }, select: { category: true } });
    if (snapshot?.category) return snapshot.category;
    let job;
    try {
      job = await this.job.getJob(jobId, correlationId);
    } catch (error) {
      if (error instanceof AppException && error.getStatus() === 404) return null; // ประกาศหายไป ⇒ ไม่มีสายงาน (ปิดไว้ก่อน)
      throw error;
    }
    if (!job.category) return null;
    await this.db.jobSnapshot.updateMany({ where: { jobId, category: null }, data: { category: job.category } });
    return job.category;
  }

  /** HR Member ที่ใบสมัครอยู่นอกสายงาน ⇒ `403 FORBIDDEN_ROLE` (`details[].issue` = `FORBIDDEN_CATEGORY`) */
  async assertInScope(user: JwtClaims, app: { jobId: string }, correlationId?: string): Promise<void> {
    const scope = this.scopeOf(user);
    if (scope === null) return;
    const category = scope.length ? await this.categoryOf(app.jobId, correlationId) : null;
    if (!category || !scope.includes(category)) {
      throw new AppException('FORBIDDEN_ROLE', 'ไม่มีสิทธิ์จัดการใบสมัครของสายงานนี้', 403, [{ field: 'job_id', issue: 'FORBIDDEN_CATEGORY' }]);
    }
  }

  /** `job_id` ของบริษัทที่อยู่ในสายงานของผู้เรียก (`null` = ไม่จำกัด) — เติมสายงานที่ยังว่างของประกาศที่มีใบสมัครก่อน */
  async jobIdsInScope(user: JwtClaims, companyId: string, correlationId?: string): Promise<string[] | null> {
    const scope = this.scopeOf(user);
    if (scope === null) return null;
    if (scope.length === 0) return [];
    const applied = await this.db.application.findMany({ where: { companyId }, distinct: ['jobId'], select: { jobId: true } });
    const ids = applied.map((row) => row.jobId);
    const known = await this.db.jobSnapshot.findMany({ where: { jobId: { in: ids } }, select: { jobId: true, category: true } });
    const byId = new Map(known.map((row) => [row.jobId, row.category]));
    const missing = ids.filter((id) => !byId.get(id));
    await mapWithConcurrency(missing, CATEGORY_LOOKUP_CONCURRENCY, async (id) => {
      byId.set(id, await this.categoryOf(id, correlationId));
    });
    return ids.filter((id) => {
      const category = byId.get(id);
      return !!category && scope.includes(category);
    });
  }
}
