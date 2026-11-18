import { Module } from '@nestjs/common';
import { InternalModule } from '../../internal/internal.module';
import { StateMachineModule } from '../../state-machine/state-machine.module';
import { ReviewModerationService } from './review-moderation.service';
import {
  CompanyReviewsController,
  HrReviewsController,
  MyReviewsController,
  StudentReviewController,
} from './reviews.controller';
import { ReviewsService } from './reviews.service';

/**
 * รีวิวบริษัท (หัวข้อ 1.8) — `OutboxWriter` จาก MessagingModule (Global), `StatusHistoryWriter` จาก StateMachineModule
 * ตัวรับ E10 (`ReviewModerationResultConsumer`) อยู่ใน `ReviewConsumersModule` แยก เพราะต้องมี `EventConsumer` (RabbitMQ)
 */
@Module({
  imports: [StateMachineModule, InternalModule],
  controllers: [StudentReviewController, MyReviewsController, HrReviewsController, CompanyReviewsController],
  providers: [ReviewsService, ReviewModerationService],
  exports: [ReviewsService, ReviewModerationService],
})
export class ReviewsModule {}
