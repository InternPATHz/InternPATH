import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { FlagModule } from '../flag/flag.module';
import { QueueModule } from '../queue/queue.module';
import { ReportActionsController } from './report-actions.controller';
import { ReportController } from './report.controller';
import { ReportResolutionService } from './report-resolution.service';
import { ReportService } from './report.service';

/** รายงานประกาศโดยนักศึกษา + ตัวนับ/ระงับอัตโนมัติ + คำตัดสินของ Admin (FlagModule ให้ LIMITS_CONFIG) */
@Module({
  imports: [FlagModule, QueueModule, AuditModule],
  controllers: [ReportController, ReportActionsController],
  providers: [ReportService, ReportResolutionService],
  exports: [ReportService],
})
export class ReportModule {}
