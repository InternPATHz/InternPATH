import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Public, Roles, RolesGuard } from '@internpath/common';
import { AcceptInvitationDto, AppointOwnerDto, InviteMemberDto, MembersQueryDto, TransferOwnerDto } from './company-members.dto';
import { CompanyMembersService } from './company-members.service';

@Controller('companies/me')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class CompanyMembersController {
  constructor(private readonly service: CompanyMembersService) {}

  @Get('members')
  members(@CurrentUser() actor: JwtClaims, @Query() query: MembersQueryDto) { return this.service.members(actor.sub, query); }

  @Post('invitations')
  invite(@CurrentUser() actor: JwtClaims, @Body() body: InviteMemberDto) { return this.service.invite(actor.sub, body.email); }

  @Delete('members/:user_id') @HttpCode(204)
  remove(@CurrentUser() actor: JwtClaims, @Param('user_id', ParseUUIDPipe) userId: string,
    @Headers('x-correlation-id') cid: string) { return this.service.remove(actor.sub, userId, cid); }

  @Post('owner-transfer')
  transfer(@CurrentUser() actor: JwtClaims, @Body() body: TransferOwnerDto) {
    return this.service.transfer(actor.sub, body.to_user_id);
  }

  @Post('owner-transfer/actions/:action') @HttpCode(204)
  transferAction(@CurrentUser() actor: JwtClaims, @Param('action') action: string,
    @Headers('x-correlation-id') cid: string) { return this.service.transferAction(actor.sub, action, cid); }
}

@Controller('auth/invitations')
@UseGuards(JwtAuthGuard)
export class InvitationController {
  constructor(private readonly service: CompanyMembersService) {}

  @Post('accept') @Public()
  accept(@Body() body: AcceptInvitationDto) { return this.service.accept(body); }
}

@Controller('admin/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminOwnerController {
  constructor(private readonly service: CompanyMembersService) {}

  @Post(':id/owner') @HttpCode(204)
  appoint(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) companyId: string,
    @Body() body: AppointOwnerDto, @Headers('x-correlation-id') cid: string) {
    return this.service.appoint(actor.sub, companyId, body.user_id, cid);
  }
}
