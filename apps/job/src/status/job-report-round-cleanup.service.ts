import {
  Inject,
  Injectable,
  Logger,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

const HOUR_MS = 60 * 60 * 1000;
const RETENTION_MS = 30 * 24 * HOUR_MS;

@Injectable()
export class JobReportRoundCleanupService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(JobReportRoundCleanupService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(@Inject(PrismaService) private readonly prisma: Pick<PrismaService, '$queryRaw'>) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.removeExpired()
        .catch(() => this.log.error('Failed to clean up expired unmatched report decisions'))
        .finally(() => {
          this.running = undefined;
        });
    }, HOUR_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  async removeExpired(now = new Date()): Promise<void> {
    const cutoff = new Date(now.getTime() - RETENTION_MS);
    // Take the same Job lock as E02/E04. A round being handled is eligible again on the next run.
    const removed = await this.prisma.$queryRaw<Array<{ job_id: string; queue_item_id: string }>>`
      WITH candidates AS (
        SELECT round.id
        FROM report_rounds AS round
        JOIN jobs ON jobs.id = round.job_id
        WHERE round.status = 'DECIDED' AND round.created_at < ${cutoff}
        FOR UPDATE OF jobs SKIP LOCKED
      )
      DELETE FROM report_rounds AS round
      USING candidates
      WHERE round.id = candidates.id AND round.status = 'DECIDED'
        AND round.created_at < ${cutoff}
      RETURNING round.job_id, round.queue_item_id
    `;
    for (const round of removed) {
      this.log.warn(
        `Removed expired unmatched report decision job=${round.job_id} round=${round.queue_item_id}`,
      );
    }
  }
}
