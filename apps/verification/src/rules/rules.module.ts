import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { RulesController } from './rules.controller';
import { RulesRepository } from './rules.repository';
import { RulesService } from './rules.service';

@Module({
  imports: [AuditModule],
  controllers: [RulesController],
  providers: [RulesRepository, RulesService],
  exports: [RulesRepository],
})
export class RulesModule {}
