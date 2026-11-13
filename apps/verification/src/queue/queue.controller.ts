import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import type { Page } from '../common/pagination';
import { QueueQuery, RejectDto } from './dto';
import { QueueActionsService } from './queue-actions.service';
import { QueueDetail, QueueListItem, QueueQueryService } from './queue-query.service';

@Controller('admin/queue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class QueueController {
  constructor(
    private readonly query: QueueQueryService,
    private readonly actions: QueueActionsService,
  ) {}

  @Get()
  list(@Query() q: QueueQuery): Promise<Page<QueueListItem>> {
    return this.query.list(q);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string): Promise<QueueDetail> {
    return this.query.detail(id);
  }

  @Post(':id/actions/approve')
  @HttpCode(204)
  approve(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: JwtClaims, @Req() req: Request): Promise<void> {
    return this.actions.approve(id, { sub: user.sub }, getCorrelationId(req));
  }

  @Post(':id/actions/reject')
  @HttpCode(204)
  reject(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: RejectDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<void> {
    return this.actions.reject(id, { sub: user.sub }, dto.reason, getCorrelationId(req));
  }
}
