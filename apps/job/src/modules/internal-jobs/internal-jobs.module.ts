import { ServiceTokenGuard } from '@internpath/common';
import { Module } from '@nestjs/common';
import { PrismaModule } from '../../prisma/prisma.module';
import { InternalJobsController } from './internal-jobs.controller';
import { InternalJobsService } from './internal-jobs.service';
import { LifecycleReservationClient } from './lifecycle-reservation.client';
import { QuotaReconciliationService } from './quota-reconciliation.service';
import { QuotaService } from './quota.service';

@Module({
  imports: [PrismaModule],
  controllers: [InternalJobsController],
  providers: [
    ServiceTokenGuard,
    InternalJobsService,
    QuotaService,
    LifecycleReservationClient,
    QuotaReconciliationService,
  ],
})
export class InternalJobsModule {}
