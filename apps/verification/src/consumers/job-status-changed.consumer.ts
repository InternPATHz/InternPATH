import type { EventEnvelope, JobStatusChangedPayload } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { JobEventsService } from '../job/job-events.service';
import type { Tx } from '../prisma/types';

/** รับ E03 `JobStatusChanged` ทุกตัวจาก Job: snapshot สถานะประกาศ, นับการปฏิเสธของบริษัท, Fail-safe `VERIFY_TIMEOUT` */
@Injectable()
export class JobStatusChangedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly jobEvents: JobEventsService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<JobStatusChangedPayload>({
      producer: 'job',
      type: 'JobStatusChanged',
      handler: (env, tx) =>
        this.jobEvents.handleJobStatusChanged(env as EventEnvelope<'JobStatusChanged', JobStatusChangedPayload>, tx),
    });
  }
}
