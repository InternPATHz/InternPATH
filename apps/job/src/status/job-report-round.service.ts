import type {
  EventEnvelope,
  JobVerifiedPayload,
  ReportThresholdReachedPayload,
} from '@internpath/contracts';
import { InvalidMessageError, isUuid } from '@internpath/common';
import { Injectable, Logger } from '@nestjs/common';
import { isUUID } from 'class-validator';
import type { Tx } from '../prisma/types';
import { JobStatusTransitionService } from './job-status-transition.service';

const EVENT_TIMESTAMP =
  /^(\d{4})-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?Z$/;
const DAYS_PER_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function eventTimestamp(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined;
  const parts = EVENT_TIMESTAMP.exec(value);
  if (!parts) return undefined;

  const year = Number(parts[1]);
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  const leapFebruary = month === 2 && year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  if (year === 0 || day > (leapFebruary ? 29 : DAYS_PER_MONTH[month - 1])) return undefined;

  return new Date(value);
}

function actorRole(decidedBy: JobVerifiedPayload['decided_by']) {
  return decidedBy === 'ADMIN' ? 'PLATFORM_ADMIN' : 'SYSTEM';
}

const BANGKOK_DATE = new Intl.DateTimeFormat('en', {
  timeZone: 'Asia/Bangkok',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function deadlinePassed(deadline: Date, now: Date): boolean {
  const parts = BANGKOK_DATE.formatToParts(now);
  const [year, month, day] = ['year', 'month', 'day'].map(
    (type) => parts.find((part) => part.type === type)!.value,
  );
  return deadline.toISOString().slice(0, 10) < `${year}-${month}-${day}`;
}

@Injectable()
export class JobReportRoundService {
  private readonly log = new Logger(JobReportRoundService.name);

  constructor(private readonly transitions: JobStatusTransitionService) {}

  private async lockJob(tx: Tx, jobId: string) {
    // E04 and E02 resolutions share this lock. Read status and round history after acquiring it.
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT id FROM jobs WHERE id = ${jobId}::uuid FOR UPDATE
    `;
    return rows.length ? tx.job.findUnique({ where: { id: jobId } }) : null;
  }

  async handleThreshold(
    env: EventEnvelope<'ReportThresholdReached', ReportThresholdReachedPayload>,
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    const reachedAt = eventTimestamp(p?.reached_at);
    if (
      !p ||
      !isUUID(p.job_id) ||
      !isUUID(p.company_id) ||
      !isUUID(p.queue_item_id) ||
      !Number.isInteger(p.report_count) ||
      p.report_count < 1 ||
      !reachedAt
    ) {
      throw new InvalidMessageError('Invalid E04 payload');
    }

    const job = await this.lockJob(tx, p.job_id);
    if (
      !job ||
      job.companyId !== p.company_id.toLowerCase() ||
      (job.status !== 'PUBLISHED' && job.status !== 'CLOSED')
    ) {
      this.log.warn('Ignored E04 for a missing, mismatched or ineligible Job');
      return;
    }

    const round = await tx.reportRound.findUnique({
      where: { jobId_queueItemId: { jobId: job.id, queueItemId: p.queue_item_id } },
    });
    if (round && round.status !== 'DECIDED') {
      this.log.warn('Ignored E04 with an already accepted report round');
      return;
    }

    const blocking = await tx.reportRound.findFirst({
      where: {
        jobId: job.id,
        OR: [{ status: 'ACTIVE' }, { reachedAt: { gt: reachedAt } }],
      },
      select: { queueItemId: true },
    });
    if (blocking) {
      this.log.warn('Ignored stale E04 or E04 for a Job with an active report round');
      return;
    }

    const now = new Date();
    const suspension = {
      to: 'SUSPENDED',
      correlationId: env.correlation_id,
      historyReason: 'REPORT_THRESHOLD',
      actorRole: 'SYSTEM',
      reasonCode: 'REPORT_THRESHOLD',
      applicationEffect: 'FREEZE',
    } as const;
    if (round) {
      const parkedDecision = round.decision;
      const removing = parkedDecision === 'REMOVE';
      if (removing) {
        if (!round.decidedBy || !round.correlationId) {
          throw new Error('Parked report decision is missing provenance');
        }
        const changed = await this.transitions.change(
          tx,
          job,
          {
            to: 'REMOVED',
            correlationId: round.correlationId,
            historyReason: parkedDecision,
            actorRole: actorRole(round.decidedBy),
            applicationEffect: 'CANCEL_PRE_APPROVAL',
            suspendedFromStatus: null,
          },
          now,
          suspension,
        );
        if (!changed) throw new Error('Locked Job changed while applying a parked report decision');
      }
      await tx.reportRound.update({
        where: { id: round.id },
        data: {
          status: 'CLOSED',
          reachedAt,
          closedAt: now,
          suspendedFromStatus: removing ? job.status : null,
        },
      });
      return;
    }

    await tx.reportRound.create({
      data: {
        queueItemId: p.queue_item_id,
        jobId: job.id,
        reachedAt,
        status: 'ACTIVE',
        suspendedFromStatus: job.status,
      },
    });
    const changed = await this.transitions.change(
      tx,
      job,
      {
        ...suspension,
        suspendedFromStatus: job.status,
      },
      now,
    );
    if (!changed) throw new Error('Locked Job changed while opening a report round');
  }

  async resolve(
    env: EventEnvelope<'JobVerified', JobVerifiedPayload>,
    decision: 'RESTORE' | 'REMOVE',
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    const queueItemId = p.queue_item_id;
    const decidedAt = eventTimestamp(p.decided_at);
    const decidedBy = p.decided_by;
    if (
      !isUUID(p.job_id) ||
      typeof queueItemId !== 'string' ||
      !isUUID(queueItemId) ||
      (p.submission_id !== undefined && !isUUID(p.submission_id)) ||
      (decidedBy !== 'SYSTEM' && decidedBy !== 'ADMIN') ||
      !decidedAt
    ) {
      this.log.warn('Ignored malformed report decision');
      return;
    }
    const correlationId = env.correlation_id;
    if (typeof correlationId !== 'string' || !isUuid(correlationId)) {
      throw new Error('Report decision requires its original UUID correlation ID');
    }

    const job = await this.lockJob(tx, p.job_id);
    if (!job) {
      this.log.warn('Ignored report decision for a missing Job');
      return;
    }

    const round = await tx.reportRound.findUnique({
      where: { jobId_queueItemId: { jobId: job.id, queueItemId } },
    });
    if (!round) {
      const active = await tx.reportRound.findFirst({
        where: { jobId: job.id, status: 'ACTIVE' },
        select: { id: true },
      });
      if (active) {
        this.log.warn('Ignored report decision without a matching active round');
        return;
      }
      await tx.reportRound.create({
        data: {
          jobId: job.id,
          queueItemId,
          status: 'DECIDED',
          decision,
          decidedAt,
          decidedBy,
          correlationId,
        },
      });
      return;
    }
    if (round.status !== 'ACTIVE' || job.status !== 'SUSPENDED') {
      this.log.warn('Ignored report decision that does not match the active round');
      return;
    }

    const now = new Date();
    const restoring = decision === 'RESTORE';
    let to: 'PUBLISHED' | 'CLOSED' | 'REMOVED' = 'REMOVED';
    if (restoring) {
      const from = job.suspendedFromStatus;
      const deadline = job.applicationDeadline;
      if ((from !== 'PUBLISHED' && from !== 'CLOSED') || deadline === null) {
        throw new Error('Suspended Job is missing its previous status or application deadline');
      }
      to = from === 'CLOSED' || deadlinePassed(deadline, now) ? 'CLOSED' : 'PUBLISHED';
    }
    const changed = await this.transitions.change(
      tx,
      job,
      {
        to,
        correlationId,
        historyReason: decision,
        actorRole: actorRole(decidedBy),
        suspendedFromStatus: null,
        ...(restoring
          ? { reasonCode: 'ADMIN_DISMISSED', applicationEffect: 'UNFREEZE' }
          : { applicationEffect: 'CANCEL_PRE_APPROVAL' }),
      },
      now,
    );
    if (!changed) throw new Error('Locked Job changed while closing a report round');
    await tx.reportRound.update({
      where: { id: round.id },
      data: { status: 'CLOSED', decision, decidedAt, decidedBy, correlationId, closedAt: now },
    });
  }
}
