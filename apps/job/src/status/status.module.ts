import { Module } from '@nestjs/common';
import { JobReportRoundCleanupService } from './job-report-round-cleanup.service';
import { JobReportRoundService } from './job-report-round.service';
import { JobStatusTransitionService } from './job-status-transition.service';
import { JobVerificationService } from './job-verification.service';

@Module({
  providers: [
    JobStatusTransitionService,
    JobVerificationService,
    JobReportRoundService,
    JobReportRoundCleanupService,
  ],
  exports: [JobVerificationService, JobReportRoundService],
})
export class StatusModule {}
