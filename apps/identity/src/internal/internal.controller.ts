import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { InternalCallers, ServiceTokenGuard, ServiceTokenPolicy } from '@internpath/common';
import { ConsentCheckBatchDto, ConsentCheckDto } from './internal.dto';
import { InternalService } from './internal.service';

@Controller('internal/v1')
@UseGuards(ServiceTokenGuard)
@ServiceTokenPolicy({ audience: 'identity', secretEnvByCaller: {
  gateway: 'IDENTITY_SERVICE_SECRET_GATEWAY',
  notification: 'IDENTITY_SERVICE_SECRET_NOTIFICATION',
  lifecycle: 'IDENTITY_SERVICE_SECRET_LIFECYCLE',
} })
export class InternalController {
  constructor(private readonly service: InternalService) {}

  @Get('users/:user_id/contact') @InternalCallers('notification')
  contact(@Param('user_id', ParseUUIDPipe) userId: string) { return this.service.contact(userId); }

  @Get('users/contacts') @InternalCallers('notification')
  contacts(@Query('ids') ids: string) { return this.service.contacts(ids); }

  // ต้องประกาศก่อน `students/:user_id` ไม่งั้น "names" ถูกจับเป็น :user_id
  @Get('students/names') @InternalCallers('lifecycle')
  studentNames(@Query('ids') ids: string) { return this.service.studentNames(ids); }

  @Get('students/summaries') @InternalCallers('lifecycle')
  studentSummaries(@Query('ids') ids: string) { return this.service.studentSummaries(ids); }

  @Get('students/:user_id') @InternalCallers('lifecycle')
  student(@Param('user_id', ParseUUIDPipe) userId: string) { return this.service.student(userId); }

  @Get('companies/:company_id/members') @InternalCallers('notification', 'lifecycle')
  members(@Param('company_id', ParseUUIDPipe) companyId: string) { return this.service.members(companyId); }

  @Post('consents/check') @HttpCode(200) @InternalCallers('lifecycle')
  consent(@Body() body: ConsentCheckDto) { return this.service.consent(body); }

  @Post('consents/check-batch') @HttpCode(200) @InternalCallers('lifecycle')
  consentBatch(@Body() body: ConsentCheckBatchDto) { return this.service.consentBatch(body); }

  @Get('admins') @InternalCallers('notification')
  admins() { return this.service.admins(); }

  @Get('denylist') @InternalCallers('gateway')
  denylist() { return this.service.denylist(); }
}
