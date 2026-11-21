import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module';
import { QueueModule } from '../queue/queue.module';

import { ReviewActionsController } from './review-actions.controller';
import { ReviewActionsService } from './review-actions.service';
import { ReviewModerationService } from './review-moderation.service';
import { ReviewReportController } from './review-report.controller';
import { ReviewReportService } from './review-report.service';

/** ตรวจรีวิว (E09/E10), รายงานรีวิว และการตัดสินของ Admin — สไลซ์ 3 */
@Module({
  imports: [QueueModule, AuditModule],
  controllers: [ReviewReportController, ReviewActionsController],
  providers: [ReviewModerationService, ReviewReportService, ReviewActionsService],
  exports: [ReviewModerationService],
})
export class ReviewModule {}
