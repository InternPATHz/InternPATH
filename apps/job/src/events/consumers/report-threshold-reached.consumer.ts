import { EventConsumer } from '@internpath/common';
import type { EventEnvelope, ReportThresholdReachedPayload } from '@internpath/contracts';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Tx } from '../../prisma/types';
import { JobReportRoundService } from '../../status/job-report-round.service';

@Injectable()
export class ReportThresholdReachedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly rounds: JobReportRoundService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<ReportThresholdReachedPayload>({
      producer: 'verification',
      type: 'ReportThresholdReached',
      handler: (env, tx) =>
        this.rounds.handleThreshold(
          env as EventEnvelope<'ReportThresholdReached', ReportThresholdReachedPayload>,
          tx,
        ),
    });
  }
}
