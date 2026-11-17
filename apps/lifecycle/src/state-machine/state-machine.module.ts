import { Module } from '@nestjs/common';
import { LifecycleConfigModule } from '../config/lifecycle-config.module';
import { InternalModule } from '../internal/internal.module';
import { PrismaModule } from '../prisma/prisma.module';
import { ApplicationStateMachine } from './application-state-machine.service';
import { ApplicationTransitionService } from './application-transition.service';
import { QuotaService } from './quota.service';
import { ReapplyPolicy } from './reapply-policy';
import { StatusHistoryWriter } from './status-history.writer';

/** State Machine ใบสมัคร (README §5.2) — `OutboxWriter` มาจาก MessagingModule (Global) */
@Module({
  imports: [PrismaModule, LifecycleConfigModule, InternalModule],
  providers: [StatusHistoryWriter, ApplicationTransitionService, QuotaService, ReapplyPolicy, ApplicationStateMachine],
  exports: [StatusHistoryWriter, ApplicationTransitionService, QuotaService, ReapplyPolicy, ApplicationStateMachine],
})
export class StateMachineModule {}
