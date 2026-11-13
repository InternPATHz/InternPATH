import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import type { Page } from '../common/pagination';
import { ClearFlagDto, FlagListQuery, SetFlagDto } from './dto';
import { FlagAdminService, FlagListItem } from './flag-admin.service';

@Controller('admin/flags/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class FlagController {
  constructor(private readonly admin: FlagAdminService) {}

  @Get()
  list(@Query() q: FlagListQuery): Promise<Page<FlagListItem>> {
    return this.admin.list(q);
  }

  /** ตั้ง/เคลียร์ธง UNDER_REVIEW ด้วยมือ (api-contract §6.2) */
  @Put(':company_id/under-review')
  set(
    @Param('company_id', ParseUUIDPipe) companyId: string,
    @Body() dto: SetFlagDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<{ company_id: string; active: boolean; changed: boolean }> {
    return this.admin.set(companyId, dto, { sub: user.sub }, getCorrelationId(req));
  }
}

/** action ของคิว COMPANY_ACCOUNT — แยก controller เพื่อไม่ให้ QueueModule ต้องพึ่ง FlagModule (circular) */
@Controller('admin/queue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class FlagQueueActionsController {
  constructor(private readonly admin: FlagAdminService) {}

  @Post(':id/actions/company-clear-flag')
  @HttpCode(204)
  clear(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ClearFlagDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<void> {
    return this.admin.clearFromQueue(id, dto.reason || undefined, { sub: user.sub }, getCorrelationId(req));
  }
}
