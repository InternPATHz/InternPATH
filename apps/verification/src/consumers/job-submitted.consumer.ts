import type { EventEnvelope, JobSubmittedPayload } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { EvaluationService } from '../evaluation/evaluation.service';
import type { Tx } from '../prisma/types';

/** รับ E01 `JobSubmitted` จาก Job แล้วส่งให้ EvaluationService (idempotency/retry/DLQ เป็นของ libs/common) */
@Injectable()
export class JobSubmittedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly evaluation: EvaluationService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<JobSubmittedPayload>({
      producer: 'job',
      type: 'JobSubmitted',
      handler: (env, tx) =>
        this.evaluation.handleJobSubmitted(env as EventEnvelope<'JobSubmitted', JobSubmittedPayload>, tx),
    });
  }
}
