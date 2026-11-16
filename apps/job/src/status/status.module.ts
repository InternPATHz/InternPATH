import { Module } from '@nestjs/common';
import { JobStatusTransitionService } from './job-status-transition.service';
import { JobVerificationService } from './job-verification.service';

@Module({
  providers: [JobStatusTransitionService, JobVerificationService],
  exports: [JobVerificationService],
})
export class StatusModule {}
