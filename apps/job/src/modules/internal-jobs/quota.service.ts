import { AppException } from '@internpath/common';
import { Injectable } from '@nestjs/common';
import type { JobStatus } from '../../../generated/client';
import { PrismaService } from '../../prisma/prisma.service';
import type { Tx } from '../../prisma/types';

export interface ReservationObservation {
  applicationId: string;
  jobId: string;
  revision: string;
}

function stateConflict(): AppException {
  return new AppException('STATE_CONFLICT', 'สถานะการจองโควตาไม่ตรงกับคำขอ', 409);
}

// Serialize all quota writes for a Job, including reconciliation. The reservation PK
// independently arbitrates a concurrent claim for the same application on different Jobs.
async function lockJob(tx: Tx, jobId: string): Promise<{ status: JobStatus } | undefined> {
  const [job] = await tx.$queryRaw<Array<{ status: JobStatus }>>`
    SELECT status FROM jobs WHERE id = ${jobId}::uuid FOR NO KEY UPDATE
  `;
  return job;
}

@Injectable()
export class QuotaService {
  constructor(private readonly prisma: PrismaService) {}

  async reserve(jobId: string, applicationId: string): Promise<void> {
    await this.prisma.$transaction(
      async (tx) => {
        const job = await lockJob(tx, jobId);
        if (!job || job.status === 'DRAFT')
          throw new AppException('NOT_FOUND', 'ไม่พบประกาศงาน', 404);

        const reservedAt = new Date();
        const { count } = await tx.quotaReservation.createMany({
          data: { applicationId, jobId, status: 'RESERVED', reservedAt },
          skipDuplicates: true,
        });
        if (count === 0) {
          const existing = await tx.quotaReservation.findUniqueOrThrow({
            where: { applicationId },
          });
          if (existing.jobId !== jobId) throw stateConflict();
          if (existing.status === 'CONFIRMED') return;
          if (existing.status === 'RESERVED') {
            // Lifecycle can retry a pending acceptance. Give it a new grace window and
            // invalidate reconciliation observations made before this reserve request.
            await tx.quotaReservation.update({
              where: { applicationId },
              data: { updatedAt: reservedAt },
            });
            return;
          }
          // The capacity update below rolls back this re-reservation if the Job is full.
          await tx.quotaReservation.update({
            where: { applicationId },
            data: {
              status: 'RESERVED',
              reservedAt,
              updatedAt: reservedAt,
              confirmedAt: null,
              releasedAt: null,
              releaseReason: null,
            },
          });
        }

        const updated = await tx.$executeRaw`
        UPDATE jobs SET quota_reserved = quota_reserved + 1, updated_at = clock_timestamp()
        WHERE id = ${jobId}::uuid AND quota_reserved + quota_confirmed < quota
      `;
        if (updated !== 1) throw new AppException('QUOTA_FULL', 'โควตาตำแหน่งเต็มแล้ว', 409);
      },
      { isolationLevel: 'ReadCommitted' },
    );
  }

  async confirm(jobId: string, applicationId: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, jobId);
      const reservation = await tx.quotaReservation.findUnique({ where: { applicationId } });
      if (!reservation || reservation.jobId !== jobId || reservation.status === 'RELEASED') {
        throw stateConflict();
      }
      if (reservation.status === 'CONFIRMED') return;
      await tx.quotaReservation.update({
        where: { applicationId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      });
      await tx.job.update({
        where: { id: jobId },
        data: { quotaReserved: { decrement: 1 }, quotaConfirmed: { increment: 1 } },
      });
    });
  }

  async release(jobId: string, applicationId: string, reason: string): Promise<void> {
    await this.releaseReservation(jobId, applicationId, reason);
  }

  async releaseObserved(observation: ReservationObservation): Promise<void> {
    await this.releaseReservation(
      observation.jobId,
      observation.applicationId,
      'RECONCILIATION',
      observation.revision,
    );
  }

  private async releaseReservation(
    jobId: string,
    applicationId: string,
    reason: string,
    revision?: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await lockJob(tx, jobId);
      const reservation = await tx.quotaReservation.findUnique({ where: { applicationId } });
      if (!reservation) return;
      if (reservation.jobId !== jobId) throw stateConflict();
      if (reservation.status === 'RELEASED') return;
      if (revision !== undefined) {
        const [unchanged] = await tx.$queryRaw<Array<{ current: boolean }>>`
          SELECT xmin::text = ${revision} AS current
          FROM quota_reservations WHERE application_id = ${applicationId}::uuid
        `;
        if (!unchanged?.current) return;
      }
      await tx.quotaReservation.update({
        where: { applicationId },
        data: { status: 'RELEASED', releasedAt: new Date(), releaseReason: reason },
      });
      await tx.job.update({
        where: { id: jobId },
        data:
          reservation.status === 'RESERVED'
            ? { quotaReserved: { decrement: 1 } }
            : { quotaConfirmed: { decrement: 1 } },
      });
    });
  }
}
