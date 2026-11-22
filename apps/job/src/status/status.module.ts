import { Module } from '@nestjs/common';
import { JobReportRoundCleanupService } from './job-report-round-cleanup.service';
import { JobReportRoundService } from './job-report-round.service';
import { JobStatusTransitionService } from './job-status-transition.service';
import { JobVerificationTimeoutService } from './job-verification-timeout.service';
import { JobVerificationService } from './job-verification.service';

@Module({
  providers: [
    JobStatusTransitionService,
    JobVerificationService,
    JobVerificationTimeoutService,
    JobReportRoundService,
    JobReportRoundCleanupService,
  ],
  exports: [JobStatusTransitionService, JobVerificationService, JobReportRoundService],
})
export class StatusModule {}
