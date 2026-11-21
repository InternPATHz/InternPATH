import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { JobStatusTransitionService } from './job-status-transition.service';

const REVIEW_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 30_000;

@Injectable()
export class JobVerificationTimeoutService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobVerificationTimeoutService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly db: PrismaService,
    private readonly transitions: JobStatusTransitionService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.advanceTimedOutJobs()
        .catch(() => this.log.error('Could not move expired Job submissions to review'))
        .finally(() => {
          this.running = undefined;
        });
    }, POLL_INTERVAL_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  async advanceTimedOutJobs(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - REVIEW_TIMEOUT_MS);
    await this.db.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM jobs
        WHERE status = 'VERIFYING' AND verifying_since <= ${cutoff} AND current_submission_id IS NOT NULL
        ORDER BY verifying_since, id LIMIT 50 FOR UPDATE SKIP LOCKED
      `;
      const jobs = await tx.job.findMany({ where: { id: { in: candidates.map(({ id }) => id) } } });
      for (const job of jobs) {
        await this.transitions.change(
          tx,
          job,
          {
            to: 'PENDING_REVIEW',
            correlationId: randomUUID(),
            historyReason: 'VERIFY_TIMEOUT',
            reasonCode: 'VERIFY_TIMEOUT',
            submissionId: job.currentSubmissionId ?? undefined,
            actorRole: 'SYSTEM',
            applicationEffect: 'FREEZE',
          },
          now,
        );
      }
    });
  }
}
