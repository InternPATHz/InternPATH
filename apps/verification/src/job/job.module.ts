import { Module } from '@nestjs/common';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { FlagModule } from '../flag/flag.module';
import { JobEventsService } from './job-events.service';
import { JobSnapshotService } from './job-snapshot.service';

@Module({
  imports: [FlagModule, EvaluationModule],
  providers: [JobSnapshotService, JobEventsService],
  exports: [JobSnapshotService, JobEventsService],
})
export class JobModule {}
