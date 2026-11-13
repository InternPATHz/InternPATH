import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { LIMITS_CONFIG, limitsFromConfig } from '../limits/limits.config';
import { QueueModule } from '../queue/queue.module';
import { FlagAdminService } from './flag-admin.service';
import { FlagController, FlagQueueActionsController } from './flag.controller';
import { FlagService } from './flag.service';

/** ธงบริษัท UNDER_REVIEW + API ของ Admin + เกณฑ์ (LIMITS_CONFIG ใช้ร่วมกับ ReportModule) — ต้องมี OutboxWriter จาก MessagingModule (หรือตัวแทนในเทสต์) */
@Module({
  imports: [QueueModule, AuditModule],
  controllers: [FlagController, FlagQueueActionsController],
  providers: [
    FlagService,
    FlagAdminService,
    { provide: LIMITS_CONFIG, inject: [ConfigService], useFactory: (c: ConfigService) => limitsFromConfig((k) => c.get(k)) },
  ],
  exports: [FlagService, LIMITS_CONFIG],
})
export class FlagModule {}
