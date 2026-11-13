import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, Res, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request, Response } from 'express';
import { ReportDto } from './dto';
import { RateLimitedException, ReportService } from './report.service';

@Controller('jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ReportController {
  constructor(private readonly reports: ReportService) {}

  /** นักศึกษารายงานประกาศ (api-contract §6.4) */
  @Post(':job_id/reports')
  @Roles('STUDENT')
  @HttpCode(201)
  async report(
    @Param('job_id', ParseUUIDPipe) jobId: string,
    @Body() dto: ReportDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
    @Res({ passthrough: true }) res: Response,
  ): Promise<{ id: string; status: 'OPEN' }> {
    try {
      return await this.reports.report(jobId, dto, user, getCorrelationId(req));
    } catch (e) {
      // ตั้ง header ก่อนให้ exception filter เขียน body (filter ไม่ล้าง header ที่ตั้งไว้)
      if (e instanceof RateLimitedException) res.setHeader('Retry-After', String(e.retryAfterSeconds));
      throw e;
    }
  }
}
