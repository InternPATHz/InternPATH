import { EventConsumer } from '@internpath/common';
import type { EventEnvelope, JobVerifiedPayload } from '@internpath/contracts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Tx } from '../../prisma/types';
import { JobVerificationService } from '../../status/job-verification.service';

@Injectable()
export class JobVerifiedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly verification: JobVerificationService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<JobVerifiedPayload>({
      producer: 'verification',
      type: 'JobVerified',
      handler: (env, tx) =>
        this.verification.handleJobVerified(
          env as EventEnvelope<'JobVerified', JobVerifiedPayload>,
          tx,
        ),
    });
  }
}
