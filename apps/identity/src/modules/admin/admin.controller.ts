import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { AdminService } from './admin.service';
import { AuditQueryDto, SetEntitlementsDto, SetPartnerDto, UserActionDto } from './admin.dto';

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminController {
  constructor(private readonly service: AdminService) {}

  @Put('companies/:id/university-partner') @HttpCode(200)
  partner(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) companyId: string,
    @Body() body: SetPartnerDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.partner(actor.sub, companyId, body.enabled, correlationId);
  }

  @Put('companies/:id/entitlements') @HttpCode(200)
  entitlements(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) companyId: string,
    @Body() body: SetEntitlementsDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.entitlements(actor.sub, companyId, body, correlationId);
  }

  @Post('users/:id/actions/:action') @HttpCode(204)
  userAction(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) userId: string,
    @Param('action') action: string, @Body() body: UserActionDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.userAction(actor.sub, userId, action, body.reason, correlationId);
  }

  @Get('audit-logs')
  audit(@CurrentUser() actor: JwtClaims, @Query() query: AuditQueryDto) { return this.service.audit(actor.sub, query); }
}
