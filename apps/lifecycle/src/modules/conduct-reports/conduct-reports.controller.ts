import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { ConductReportItem, Paginated } from '@internpath/contracts';
import { AcknowledgeConductReportDto, AdvisorConductReportsQueryDto, CreateConductReportDto } from './conduct-reports.dto';
import { ConductReportsService } from './conduct-reports.service';

/** HR รายงานพฤติกรรมนักศึกษาที่กำลังฝึกงานถึงอาจารย์ที่ปรึกษา (เฉพาะ `IN_PROGRESS`) */
@Controller('hr/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrConductReportsController {
  constructor(private readonly service: ConductReportsService) {}

  @Get(':id/conduct-reports')
  list(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<{ data: ConductReportItem[] }> {
    return this.service.listForHr(user, id, cid);
  }

  @Post(':id/conduct-reports')
  create(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateConductReportDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ConductReportItem> {
    return this.service.create(user, id, body, cid);
  }
}

/** อาจารย์ดูรายงานพฤติกรรมของนักศึกษาในความดูแล และกดรับทราบ (ใส่หมายเหตุถึงบริษัทได้) */
@Controller('advisor/conduct-reports')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR')
export class AdvisorConductReportsController {
  constructor(private readonly service: ConductReportsService) {}

  @Get()
  list(@CurrentUser() user: JwtClaims, @Query() query: AdvisorConductReportsQueryDto): Promise<Paginated<ConductReportItem>> {
    return this.service.listForAdvisor(user.sub, query.status, query.page, query.page_size);
  }

  @Post(':id/actions/acknowledge')
  @HttpCode(200)
  acknowledge(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AcknowledgeConductReportDto,
  ): Promise<ConductReportItem> {
    return this.service.acknowledge(user, id, body);
  }
}
