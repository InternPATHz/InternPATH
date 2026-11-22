import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { bangkokDate } from './application-deadline';
import { JobStatusTransitionService } from './job-status-transition.service';

const POLL_INTERVAL_MS = 30_000;
const BATCH_SIZE = 50;

@Injectable()
export class JobDeadlineClosureService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobDeadlineClosureService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly db: PrismaService,
    private readonly transitions: JobStatusTransitionService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.closeExpiredJobs()
        .catch(() => this.log.error('Could not close expired Job postings'))
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

  async closeExpiredJobs(now = new Date()): Promise<void> {
    const today = bangkokDate(now);
    await this.db.$transaction(async (tx) => {
      const candidates = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id FROM jobs
        WHERE status = 'PUBLISHED' AND application_deadline < ${today}::date
        ORDER BY application_deadline, id
        LIMIT ${BATCH_SIZE} FOR UPDATE SKIP LOCKED
      `;
      const jobs = await tx.job.findMany({ where: { id: { in: candidates.map(({ id }) => id) } } });
      for (const job of jobs) {
        await this.transitions.change(
          tx,
          job,
          {
            to: 'CLOSED',
            correlationId: randomUUID(),
            historyReason: 'DEADLINE_EXPIRED',
            actorRole: 'SYSTEM',
            applicationEffect: 'NONE',
            changes: { closedAt: now },
          },
          now,
        );
      }
    });
  }
}
