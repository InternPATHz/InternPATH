import { Module } from '@nestjs/common';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { ProblemReportsModule } from '../problem-reports/problem-reports.module';
import { AdminLifecycleController } from './admin-lifecycle.controller';
import { AdminLifecycleService } from './admin-lifecycle.service';

/** Admin ของ Lifecycle (หัวข้อ 1.9, api-contract §7.7) — `OutboxWriter` มาจาก MessagingModule (Global) */
@Module({
  imports: [StateMachineModule, ProblemReportsModule],
  controllers: [AdminLifecycleController],
  providers: [AdminLifecycleService],
})
export class AdminLifecycleModule {}
