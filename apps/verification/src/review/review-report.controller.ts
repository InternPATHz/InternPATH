import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import { ReviewReportDto } from './dto';
import { ReviewReportService } from './review-report.service';

@Controller('reviews')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReviewReportController {
  constructor(private readonly reports: ReviewReportService) {}

  /** นักศึกษา/HR รายงานรีวิวที่เผยแพร่อยู่ (api-contract §6.4) */
  @Post(':review_id/reports')
  @Roles('STUDENT', 'COMPANY_HR')
  @HttpCode(201)
  report(
    @Param('review_id', ParseUUIDPipe) reviewId: string,
    @Body() dto: ReviewReportDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<{ id: string; status: 'OPEN' }> {
    return this.reports.report(reviewId, dto, user, getCorrelationId(req));
  }
}
