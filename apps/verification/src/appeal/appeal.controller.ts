import { Body, Controller, Get, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import { AppealService, JobResultView } from './appeal.service';
import { AppealDto } from './dto';

@Controller('verification/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AppealController {
  constructor(private readonly appeals: AppealService) {}

  /** ผลตรวจล่าสุดของประกาศ — HR เจ้าของประกาศ หรือ Admin */
  @Get(':job_id/result')
  @Roles('COMPANY_HR', 'PLATFORM_ADMIN')
  result(@Param('job_id', ParseUUIDPipe) jobId: string, @CurrentUser() user: JwtClaims): Promise<JobResultView> {
    return this.appeals.getResult(jobId, user);
  }

  /** อุทธรณ์ผล AUTO_REJECT (HR เจ้าของประกาศ เท่านั้น) */
  @Post(':job_id/appeal')
  @Roles('COMPANY_HR')
  appeal(
    @Param('job_id', ParseUUIDPipe) jobId: string,
    @Body() dto: AppealDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ) {
    return this.appeals.appeal(jobId, dto.statement, user, getCorrelationId(req));
  }
}
