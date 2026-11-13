import type { EventEnvelope, JobStatusChangedPayload } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { EvaluationService } from '../evaluation/evaluation.service';
import type { Tx } from '../prisma/types';

/** รับ E03 `JobStatusChanged` จาก Job (ใช้เฉพาะ VERIFY_TIMEOUT ในสไลซ์ 1) */
@Injectable()
export class JobStatusChangedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly evaluation: EvaluationService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<JobStatusChangedPayload>({
      producer: 'job',
      type: 'JobStatusChanged',
      handler: (env, tx) =>
        this.evaluation.handleJobStatusChanged(env as EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx),
    });
  }
}
