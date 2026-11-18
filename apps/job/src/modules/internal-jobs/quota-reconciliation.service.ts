import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import { LifecycleReservationClient } from './lifecycle-reservation.client';
import { QuotaService, type ReservationObservation } from './quota.service';

const MINUTE_MS = 60_000;
const BATCH_SIZE = 500;

@Injectable()
export class QuotaReconciliationService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly log = new Logger(QuotaReconciliationService.name);
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly lifecycle: LifecycleReservationClient,
    private readonly quota: QuotaService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => {
      if (this.running) return;
      void this.reconcile().catch(() => this.log.error('Job quota reconciliation failed'));
    }, 30 * MINUTE_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  reconcile(now = new Date()): Promise<void> {
    this.running ??= this.reconcileBatches(new Date(now.getTime() - 15 * MINUTE_MS)).finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async reconcileBatches(cutoff: Date): Promise<void> {
    let after: string | undefined;
    for (;;) {
      // xmin is a PostgreSQL row revision. It detects concurrent reservation changes
      // without rounding timestamptz values through JavaScript or holding a lock over HTTP.
      const batch = await this.prisma.$queryRaw<ReservationObservation[]>`
        SELECT application_id AS "applicationId", job_id AS "jobId", xmin::text AS "revision"
        FROM quota_reservations
        WHERE status IN ('RESERVED', 'CONFIRMED')
          AND reserved_at < ${cutoff} AND updated_at < ${cutoff}
          ${after === undefined ? Prisma.empty : Prisma.sql`AND application_id > ${after}::uuid`}
        ORDER BY application_id
        LIMIT ${BATCH_SIZE}
      `;
      if (!batch.length) return;
      const results = await this.lifecycle.check(batch.map(({ applicationId }) => applicationId));
      if (!results) {
        this.log.warn('Lifecycle reservation-check failed or returned an invalid batch');
      } else {
        const expired = new Set(
          results
            .filter((result) => !result.should_hold_quota)
            .map((result) => result.application_id),
        );
        for (const reservation of batch) {
          if (expired.has(reservation.applicationId)) {
            await this.quota.releaseObserved(reservation);
          }
        }
      }
      if (batch.length < BATCH_SIZE) return;
      after = batch[batch.length - 1].applicationId;
    }
  }
}
