import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import { PublishReviewDto, RemoveReviewDto } from './dto';
import { ReviewActionsService } from './review-actions.service';

/** action ตัดสินรายการรีวิวในคิว (api-contract §6.1) — แยกจาก QueueController เหมือน ReportActionsController */
@Controller('admin/queue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class ReviewActionsController {
  constructor(private readonly actions: ReviewActionsService) {}

  /** เผยแพร่รีวิวที่ถูกพัก หรือยืนยันให้รีวิวที่ถูกรายงานคงอยู่ */
  @Post(':id/actions/publish-review')
  @HttpCode(204)
  publish(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: PublishReviewDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<void> {
    return this.actions.publish(id, { sub: user.sub }, dto.reason || undefined, getCorrelationId(req));
  }

  /** ลบรีวิว (ต้องมีเหตุผล) */
  @Post(':id/actions/remove-review')
  @HttpCode(204)
  remove(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RemoveReviewDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<void> {
    return this.actions.remove(id, { sub: user.sub }, dto.reason, getCorrelationId(req));
  }
}
