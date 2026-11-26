import { AppException } from '@internpath/common';
import type { InternalJobResponse } from '@internpath/contracts';
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class InternalJobsService {
  constructor(private readonly prisma: PrismaService) {}

  async detail(jobId: string): Promise<InternalJobResponse> {
    const job = await this.prisma.job.findUnique({
      where: { id: jobId, status: { not: 'DRAFT' } },
      select: {
        id: true,
        companyId: true,
        status: true,
        quota: true,
        quotaReserved: true,
        quotaConfirmed: true,
        jobTitle: true,
        category: true,
        targetMajors: true,
        applicationDeadline: true,
        internshipPeriodStart: true,
        internshipPeriodEnd: true,
        entityVersion: true,
      },
    });
    if (!job) throw new AppException('NOT_FOUND', 'ไม่พบประกาศงาน', 404);
    // Job completeness and capacity CHECKs guarantee these fields outside DRAFT.
    if (
      job.quota === null ||
      job.quotaReserved === null ||
      job.quotaConfirmed === null ||
      job.jobTitle === null ||
      job.category === null ||
      job.applicationDeadline === null
    ) {
      throw new Error('Internal Job fields are incomplete');
    }
    return {
      job_id: job.id,
      company_id: job.companyId,
      status: job.status,
      quota: job.quota,
      quota_available: job.quota - job.quotaReserved - job.quotaConfirmed,
      job_title: job.jobTitle,
      category: job.category,
      target_majors: job.targetMajors,
      application_deadline: job.applicationDeadline.toISOString().slice(0, 10),
      // ช่วงฝึกงานของประกาศ — Lifecycle ใช้ตรวจวันเริ่ม/จบที่ HR ตอบรับ (ไม่กำหนด ⇒ null)
      internship_period_start: job.internshipPeriodStart?.toISOString().slice(0, 10) ?? null,
      internship_period_end: job.internshipPeriodEnd?.toISOString().slice(0, 10) ?? null,
      entity_version: job.entityVersion,
    };
  }
}
