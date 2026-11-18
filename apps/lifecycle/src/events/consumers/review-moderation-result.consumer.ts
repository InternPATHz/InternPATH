import { EventConsumer } from '@internpath/common';
import type { EventEnvelope, ReviewModerationResultPayload } from '@internpath/contracts';
import { Injectable, Module, type OnModuleInit } from '@nestjs/common';
import type { Tx } from '../../prisma/types';
import { REVIEW_MODERATION_RESULT } from '../producers/review-events';
import { ReviewModerationService } from '../../modules/reviews/review-moderation.service';
import { ReviewsModule } from '../../modules/reviews/reviews.module';

/** สมัครรับ E10 จาก Verification — กันซ้ำ/Retry 3 ครั้ง/DLQ ทำโดย `EventConsumer` ของ libs/common */
@Injectable()
export class ReviewModerationResultConsumer implements OnModuleInit {
  constructor(
    private readonly consumer: EventConsumer<Tx>,
    private readonly moderation: ReviewModerationService,
  ) {}

  onModuleInit(): Promise<void> {
    return this.consumer.subscribe<ReviewModerationResultPayload>({
      producer: 'verification',
      type: REVIEW_MODERATION_RESULT,
      handler: async (env, tx) => {
        await this.moderation.handle(env as EventEnvelope<string, ReviewModerationResultPayload>, tx);
      },
    });
  }
}

/** โหลดเฉพาะในแอปจริง (มี MessagingModule.consumes) — เทสต์ HTTP ใช้ `ReviewsModule` อย่างเดียว */
@Module({
  imports: [ReviewsModule],
  providers: [ReviewModerationResultConsumer],
})
export class ReviewConsumersModule {}
