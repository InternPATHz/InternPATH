import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AuditModule } from '../audit/audit.module';
import { RulesModule } from '../rules/rules.module';
import { QueueActionsService } from './queue-actions.service';
import { QueueController } from './queue.controller';
import { QueueQueryService } from './queue-query.service';
import { QueueService } from './queue.service';
import { SLA_CONFIG, slaFromConfig } from './sla';

@Module({
  imports: [AuditModule, RulesModule],
  controllers: [QueueController],
  providers: [
    QueueService,
    QueueQueryService,
    QueueActionsService,
    { provide: SLA_CONFIG, inject: [ConfigService], useFactory: (c: ConfigService) => slaFromConfig((k) => c.get(k)) },
  ],
  exports: [QueueService, SLA_CONFIG],
})
export class QueueModule {}
