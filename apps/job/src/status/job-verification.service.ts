import type {
  ApplicationEffect,
  EventEnvelope,
  JobStatus,
  JobVerifiedPayload,
} from '@internpath/contracts';
import { Injectable, Logger } from '@nestjs/common';
import type { Tx } from '../prisma/types';
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
  AUTO_REJECT: { from: 'VERIFYING', to: 'AUTO_REJECTED' },
  APPEAL_ACCEPTED: { from: 'AUTO_REJECTED', to: 'PENDING_REVIEW', applicationEffect: 'FREEZE' },
  ADMIN_APPROVE: { from: 'PENDING_REVIEW', to: 'PUBLISHED', applicationEffect: 'UNFREEZE' },
  ADMIN_REJECT: { from: 'PENDING_REVIEW', to: 'ADMIN_REJECTED' },
};

@Injectable()
export class JobVerificationService {
  private readonly log = new Logger(JobVerificationService.name);

  constructor(private readonly transitions: JobStatusTransitionService) {}

  async handleJobVerified(
    env: EventEnvelope<'JobVerified', JobVerifiedPayload>,
    tx: Tx,
  ): Promise<void> {
    const p = env.payload;
    // RESTORE/REMOVE await the PM-approved report-round contract. Unknown decisions also
    // fail explicitly, so shared retry/DLQ handles them without a successful processed marker.
    if (!Object.prototype.hasOwnProperty.call(TRANSITIONS, p.decision)) {
      const error = new Error(
        'Unsupported JobVerified decision; report decisions await an approved round contract',
      );
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
        // Rejections affect both pre/post-approval applications. No single effect is
        // specified for them; leave the optional hint absent for Lifecycle to interpret.
        applicationEffect: transition.applicationEffect,
      },
      new Date(),
    );
  }
}
