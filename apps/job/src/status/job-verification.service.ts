import type {
  ApplicationEffect,
  EventEnvelope,
  JobStatus,
  JobVerifiedPayload,
} from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../prisma/types';
import { JobReportRoundService } from './job-report-round.service';
import { JobStatusTransitionService } from './job-status-transition.service';

type ScreeningDecision = Exclude<JobVerifiedPayload['decision'], 'RESTORE' | 'REMOVE'>;
interface DecisionTransition {
  from: JobStatus;
  to: JobStatus;
  applicationEffect?: ApplicationEffect;
}

const TRANSITIONS: Record<ScreeningDecision, DecisionTransition> = {
  APPROVE: { from: 'VERIFYING', to: 'PUBLISHED', applicationEffect: 'UNFREEZE' },
  PENDING_REVIEW: { from: 'VERIFYING', to: 'PENDING_REVIEW', applicationEffect: 'FREEZE' },
  AUTO_REJECT: {
    from: 'VERIFYING',
    to: 'AUTO_REJECTED',
    applicationEffect: 'CANCEL_PRE_APPROVAL',
  },
  APPEAL_ACCEPTED: { from: 'AUTO_REJECTED', to: 'PENDING_REVIEW', applicationEffect: 'FREEZE' },
  ADMIN_APPROVE: { from: 'PENDING_REVIEW', to: 'PUBLISHED', applicationEffect: 'UNFREEZE' },
  ADMIN_REJECT: {
    from: 'PENDING_REVIEW',
    to: 'ADMIN_REJECTED',
    applicationEffect: 'CANCEL_PRE_APPROVAL',
  },
};

@Injectable()
export class JobVerificationService {
  private readonly log = new Logger(JobVerificationService.name);

  constructor(
    private readonly transitions: JobStatusTransitionService,
    private readonly rounds: JobReportRoundService,
  ) {}

  async handleJobVerified(
    env: EventEnvelope<'JobVerified', JobVerifiedPayload>,
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    if (p.decision === 'RESTORE' || p.decision === 'REMOVE') {
      return this.rounds.resolve(env, p.decision, tx);
    }
    // Unknown decisions still follow the shared retry/DLQ behavior.
    if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, p.decision)) {
      const error = new Error('Unsupported JobVerified decision');
      error.name = 'UnsupportedJobVerifiedDecisionError';
      throw error;
    }
    const transition = TRANSITIONS[p.decision as ScreeningDecision];
    const job = await tx.job.findUnique({ where: { id: p.job_id } });
    if (
      !job ||
      job.status !== transition.from ||
      job.currentSubmissionId === null ||
      job.currentSubmissionId !== p.submission_id
    ) {
      this.log.warn(
        'Ignored JobVerified with a missing Job, stale status or mismatched submission',
      );
      return;
    }
    await this.transitions.change(
      tx,
      job,
      {
        to: transition.to,
        correlationId: env.correlation_id,
        historyReason: p.decision,
        actorRole: p.decided_by === 'ADMIN' ? 'PLATFORM_ADMIN' : 'SYSTEM',
        // Lifecycle owns cancellation before approval and advisor flagging afterward.
        applicationEffect: transition.applicationEffect,
        ...(p.decision === 'ADMIN_REJECT'
          ? { adminReason: p.reasons.find((reason) => reason.code === 'ADMIN_REASON')?.detail ?? null }
          : p.decision === 'ADMIN_APPROVE'
            ? { adminReason: null }
            : {}),
      },
      new Date(),
    );
  }
}
