import { randomUUID } from 'node:crypto';
import type { EventEnvelope, UserDeletionRequestedPayload } from '@internpath/contracts';
import type { PrismaClient } from '../../generated/client';
import type { Tx } from '../../src/prisma/types';
import { NOW, seedJob } from './job-events';

export const DELETION_QUEUE = 'job.UserDeletionRequested';

export function deletionRequested(): EventEnvelope<
  'UserDeletionRequested',
  UserDeletionRequestedPayload
> {
  return {
    event_id: randomUUID(),
    type: 'UserDeletionRequested',
    version: 1,
    producer: 'identity',
    correlation_id: randomUUID(),
    occurred_at: NOW.toISOString(),
    payload: {
      user_id: randomUUID(),
      anonymous_actor_id: randomUUID(),
      role: 'COMPANY_HR',
      company_id: randomUUID(),
      requested_at: NOW.toISOString(),
      mode: 'DELETE_AND_ANONYMIZE',
    },
  };
}

export async function seedDeletionFixture(prisma: PrismaClient, userId: string) {
  const otherActor = randomUUID();
  const target = await seedJob(prisma, 'SUSPENDED', {
    createdBy: userId,
    suspendedFromStatus: 'PUBLISHED',
    publishedAt: NOW,
  });
  const other = await seedJob(prisma, 'PUBLISHED', { createdBy: otherActor });
  const jobIds = [target.id, other.id];
  const submission = await prisma.jobSubmission.create({
    data: {
      jobId: target.id,
      kind: 'NEW',
      changedFields: [],
      submittedBy: userId,
      submittedAt: NOW,
    },
  });
  await prisma.job.update({
    where: { id: target.id },
    data: { currentSubmissionId: submission.id },
  });
  await prisma.jobSubmission.create({
    data: {
      jobId: other.id,
      kind: 'EDIT',
      changedFields: ['description'],
      submittedBy: otherActor,
      submittedAt: NOW,
    },
  });
  await prisma.reportRound.create({
    data: {
      jobId: target.id,
      queueItemId: randomUUID(),
      status: 'ACTIVE',
      reachedAt: NOW,
      suspendedFromStatus: 'PUBLISHED',
    },
  });
  await prisma.statusHistory.createMany({
    data: [
      { entityId: target.id, actorId: userId, actorRole: 'COMPANY_HR' },
      { entityId: other.id, actorId: otherActor, actorRole: 'COMPANY_HR' },
      { entityId: target.id, actorId: null, actorRole: 'SYSTEM' },
      { entityId: other.id, actorId: userId, actorRole: 'COMPANY_HR' },
    ].map((actor, index) => ({
      ...actor,
      entity: 'JOB',
      fromStatus: 'VERIFYING',
      toStatus: 'PUBLISHED',
      reason: 'Fixture history',
      occurredAt: new Date(NOW.getTime() + index),
      correlationId: randomUUID(),
    })),
  });

  const read = async (client: Tx = prisma) => ({
    jobs: await client.job.findMany({ where: { id: { in: jobIds } }, orderBy: { id: 'asc' } }),
    submissions: await client.jobSubmission.findMany({
      where: { jobId: { in: jobIds } },
      orderBy: { id: 'asc' },
    }),
    history: await client.statusHistory.findMany({
      where: { entityId: { in: jobIds } },
      orderBy: { occurredAt: 'asc' },
    }),
    rounds: await client.reportRound.findMany({
      where: { jobId: { in: jobIds } },
      orderBy: { id: 'asc' },
    }),
  });

  return { read };
}

type Fixture = Awaited<ReturnType<typeof seedDeletionFixture>>;

export function anonymizedState(
  before: Awaited<ReturnType<Fixture['read']>>,
  { user_id: userId, anonymous_actor_id: anonymousId }: UserDeletionRequestedPayload,
) {
  const replace = <T extends string | null>(id: T) => (id === userId ? anonymousId : id);
  return {
    jobs: before.jobs.map((row) => ({ ...row, createdBy: replace(row.createdBy) })),
    submissions: before.submissions.map((row) => ({
      ...row,
      submittedBy: replace(row.submittedBy),
    })),
    history: before.history.map((row) => ({ ...row, actorId: replace(row.actorId) })),
    rounds: before.rounds,
  };
}

export function deletionMarker(tx: Tx, eventId: string): Promise<number> {
  return tx.processedEvent.count({ where: { eventId, consumer: DELETION_QUEUE } });
}
