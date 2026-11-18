import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { Paginated, ProblemReportItem } from '@internpath/contracts';
import { AdvisorProblemReportsQueryDto } from '../advisor/advisor.dto';
import { ResolveProblemReportDto } from './problem-reports.dto';
import { ProblemReportsService } from './problem-reports.service';

/** api-contract §7.4 — รายงานปัญหาของนักศึกษาในความดูแล (UAT-39) */
@Controller('advisor/problem-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR')
export class AdvisorProblemReportsController {
  constructor(private readonly service: ProblemReportsService) {}

  @Get()
  list(@CurrentUser() user: JwtClaims, @Query() query: AdvisorProblemReportsQueryDto): Promise<Paginated<ProblemReportItem>> {
    return this.service.listForAdvisor(user.sub, query.status, query.page, query.page_size);
  }
}

/**
 * api-contract §7.4 — `POST /problem-reports/{id}/actions/{acknowledge|resolve}` เฉพาะอาจารย์และ Admin
 * HR/นักศึกษา ⇒ `403 FORBIDDEN_ROLE` (บริษัทมองไม่เห็นรายงาน — README §5.11, UAT-39 ข้อ 3)
 */
@Controller('problem-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR', 'PLATFORM_ADMIN')
export class ProblemReportActionsController {
  constructor(private readonly service: ProblemReportsService) {}

  @Post(':id/actions/acknowledge')
  @HttpCode(200)
  acknowledge(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<ProblemReportItem> {
    return this.service.acknowledge(user, id);
  }

  @Post(':id/actions/resolve')
  @HttpCode(200)
  resolve(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ResolveProblemReportDto,
  ): Promise<ProblemReportItem> {
    return this.service.resolve(user, id, body);
  }
}
