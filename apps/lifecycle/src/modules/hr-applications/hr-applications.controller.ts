import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { HrApplicationDetail, HrApplicationItem, HrStartResponse, Paginated } from '@internpath/contracts';
import {
  HrAcceptDto,
  HrApplicationsQueryDto,
  HrEvaluateDto,
  HrReasonDto,
  HrStartDto,
  HrTerminateDto,
} from './hr-applications.dto';
import { HrApplicationsService } from './hr-applications.service';

/**
 * api-contract §7.3 — ใบสมัครฝั่ง HR (`/hr/applications/...`)
 * `certificate` (1.7) และรีวิว (1.8) อยู่ในหัวข้อของตัวเอง
 */
@Controller('hr/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrApplicationsController {
  constructor(private readonly service: HrApplicationsService) {}

  @Get()
  list(
    @CurrentUser() user: JwtClaims,
    @Query() query: HrApplicationsQueryDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<Paginated<HrApplicationItem>> {
    return this.service.list(user, query, cid);
  }

  @Get(':id')
  detail(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail> {
    return this.service.detail(user, id, cid);
  }

  @Post(':id/actions/accept')
  @HttpCode(200)
  accept(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HrAcceptDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail> {
    return this.service.accept(user, id, body, cid);
  }

  @Post(':id/actions/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HrReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail> {
    return this.service.transition(user, id, 'reject', body.reason, cid);
  }

  @Post(':id/actions/rescind-offer')
  @HttpCode(200)
  rescindOffer(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HrReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail> {
    return this.service.transition(user, id, 'rescind-offer', body.reason, cid);
  }

  @Post(':id/actions/start')
  @HttpCode(200)
  start(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HrStartDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail & HrStartResponse> {
    return this.service.start(user, id, body, cid);
  }

  @Post(':id/actions/terminate')
  @HttpCode(200)
  terminate(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HrTerminateDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail> {
    return this.service.terminate(user, id, body, cid);
  }

  @Post(':id/actions/evaluate')
  @HttpCode(200)
  evaluate(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: HrEvaluateDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<HrApplicationDetail> {
    return this.service.evaluate(user, id, body, cid);
  }
}
