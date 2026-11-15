import type { EventEnvelope, ReviewSubmittedPayload } from '@internpath/contracts';
import { EventConsumer } from '@internpath/common';
import { Injectable, OnModuleInit } from '@nestjs/common';
import type { Tx } from '../prisma/types';
import { ReviewModerationService } from '../review/review-moderation.service';

/** รับ E09 `ReviewSubmitted` จาก Lifecycle: สแกนรีวิวแล้วตอบด้วย E10 */
@Injectable()
export class ReviewSubmittedConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly moderation: ReviewModerationService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<ReviewSubmittedPayload>({
      producer: 'lifecycle',
      type: 'ReviewSubmitted',
      handler: (env, tx) =>
        this.moderation.handleReviewSubmitted(env as EventEnvelope<'ReviewSubmitted', ReviewSubmittedPayload>, tx),
    });
  }
}
