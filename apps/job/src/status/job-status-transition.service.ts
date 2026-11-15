import { asUuid, OutboxWriter } from '@internpath/common';
import type { ApplicationEffect, JobStatus, JobStatusChangedPayload } from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Job } from '../../generated/client';
import type { Tx } from '../prisma/types';

interface Transition {
  to: JobStatus;
  correlationId: string;
  historyReason: string;
  reasonCode?: string;
  applicationEffect?: ApplicationEffect;
  suspendedFromStatus?: JobStatus | null;
}

/** Called only with the EventConsumer transaction: never opens or commits its own transaction. */
@Injectable()
export class JobStatusTransitionService {
  private readonly log = new Logger(JobStatusTransitionService.name);

  constructor(private readonly outbox: OutboxWriter) {}

  async change(tx: Tx, before: Job, transition: Transition, now: Date): Promise<boolean> {
    if (before.status === transition.to) {
      this.log.warn('Ignored Job transition without a status change');
      return false;
    }
    const updated = await tx.job.updateMany({
      where: {
        id: before.id,
        companyId: before.companyId,
        status: before.status,
        currentSubmissionId: before.currentSubmissionId,
        version: before.version,
        entityVersion: before.entityVersion,
      },
      data: {
        status: transition.to,
        version: { increment: 1 },
        entityVersion: { increment: 1 },
        ...(transition.suspendedFromStatus === undefined
          ? {}
          : { suspendedFromStatus: transition.suspendedFromStatus }),
      },
    });
    if (updated.count === 0) {
      const current = await tx.job.findUnique({ where: { id: before.id } });
      if (
        current?.status === before.status &&
        current.currentSubmissionId === before.currentSubmissionId &&
        current.companyId === before.companyId
      ) {
        // An unrelated concurrent edit must not cause an otherwise-current decision to be lost.
        throw new Error('Concurrent Job update; retry delivery');
      }
      this.log.warn('Ignored stale or conflicting Job transition');
      return false;
    }

    const correlationId = asUuid(transition.correlationId);
    await tx.statusHistory.create({
      data: {
        entity: 'JOB',
        entityId: before.id,
        fromStatus: before.status,
        toStatus: transition.to,
        // The local SYSTEM applies an event; E02/E04 do not carry an actor user ID.
        actorId: null,
        actorRole: 'SYSTEM',
        reason: transition.historyReason,
        correlationId,
        occurredAt: now,
      },
    });
    const payload: JobStatusChangedPayload = {
      job_id: before.id,
      company_id: before.companyId,
      from_status: before.status,
      to_status: transition.to,
      entity_version: before.entityVersion + 1,
      changed_at: now.toISOString(),
      ...(transition.reasonCode === undefined ? {} : { reason_code: transition.reasonCode }),
      ...(transition.applicationEffect === undefined
        ? {}
        : { application_effect: transition.applicationEffect }),
    };
    await this.outbox.add(tx, {
      type: 'JobStatusChanged',
      aggregateId: before.id,
      correlationId,
      payload,
    });
    return true;
  }
}
