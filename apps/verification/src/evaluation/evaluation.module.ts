import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { RulesModule } from '../rules/rules.module';
import { EvaluationService } from './evaluation.service';

@Module({ imports: [RulesModule, QueueModule], providers: [EvaluationService], exports: [EvaluationService] })
export class EvaluationModule {}
