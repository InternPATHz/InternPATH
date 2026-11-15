import { randomUUID } from 'node:crypto';
import type {
  EventEnvelope,
  JobStatus,
  JobVerifiedPayload,
  ReportThresholdReachedPayload,
} from '@internpath/contracts';
import type { Prisma, PrismaClient } from '../../generated/client';

export const NOW = new Date('2026-11-15T10:00:00.000Z');

export function jobVerified(
  jobId: string,
  submissionId: string,
  decision: JobVerifiedPayload['decision'] = 'APPROVE',
): EventEnvelope<'JobVerified', JobVerifiedPayload> {
  return {
    event_id: randomUUID(),
    type: 'JobVerified',
    version: 1,
    producer: 'verification',
    correlation_id: randomUUID(),
    occurred_at: NOW.toISOString(),
    payload: {
      job_id: jobId,
      submission_id: submissionId,
      decision,
      reasons: [],
      is_appeal: false,
      decided_by: 'SYSTEM',
      decided_at: NOW.toISOString(),
    },
  };
}

export function reportThreshold(
  jobId: string,
  companyId: string,
): EventEnvelope<'ReportThresholdReached', ReportThresholdReachedPayload> {
  return {
    event_id: randomUUID(),
    type: 'ReportThresholdReached',
    version: 1,
    producer: 'verification',
    correlation_id: randomUUID(),
    occurred_at: NOW.toISOString(),
    payload: {
      job_id: jobId,
      company_id: companyId,
      report_count: 3,
      queue_item_id: randomUUID(),
      reached_at: NOW.toISOString(),
    },
  };
}

/** Complete records keep the non-DRAFT database invariants active in consumer tests. */
export async function seedJob(
  prisma: PrismaClient,
  status: JobStatus = 'VERIFYING',
  overrides: Partial<Prisma.JobUncheckedCreateInput> = {},
) {
  const job = await prisma.job.create({
    data: {
      companyId: randomUUID(),
      createdBy: randomUUID(),
      currentSubmissionId: randomUUID(),
      status,
      entityVersion: 10,
      version: 4,
      category: 'TECH_IT',
      jobTitle: 'Software intern',
      description: 'Description',
      responsibilities: 'Build software',
      qualifications: 'Student',
      location: 'Bangkok',
      workMode: 'ONSITE',
      hoursPerWeek: 40,
      allowanceType: 'NONE',
      internshipPeriodStart: new Date('2027-01-01'),
      internshipPeriodEnd: new Date('2027-04-01'),
      targetMajors: ['CS'],
      quota: 5,
      applicationDeadline: new Date('2026-12-01'),
      ...overrides,
    },
  });
  return job;
}
