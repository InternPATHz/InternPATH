import { Module } from '@nestjs/common';
import { QueueModule } from '../queue/queue.module';
import { EvaluationService } from './evaluation.service';

@Module({ imports: [QueueModule], providers: [EvaluationService], exports: [EvaluationService] })
export class EvaluationModule {}
