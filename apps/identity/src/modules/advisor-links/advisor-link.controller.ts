import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { AdvisorActionDto, AdvisorIdDto, AdvisorSearchDto, AdminAdvisorQueryDto } from './advisor-link.dto';
import { AdvisorLinkService } from './advisor-link.service';

@Controller('users/me')
@UseGuards(JwtAuthGuard)
export class IdentityMeController {
  constructor(private readonly service: AdvisorLinkService) {}

  @Get()
  me(@CurrentUser() actor: JwtClaims) { return this.service.me(actor.sub); }

  @Post('advisor-link')
  @UseGuards(RolesGuard) @Roles('STUDENT')
  request(@CurrentUser() actor: JwtClaims, @Body() body: AdvisorIdDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.request(actor.sub, body.advisor_id, correlationId);
  }

  @Delete('advisor-link') @HttpCode(204)
  @UseGuards(RolesGuard) @Roles('STUDENT')
  cancel(@CurrentUser() actor: JwtClaims, @Headers('x-correlation-id') correlationId: string) {
    return this.service.cancel(actor.sub, correlationId);
  }
}

@Controller('advisors')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class AdvisorsController {
  constructor(private readonly service: AdvisorLinkService) {}

  @Get()
  list(@CurrentUser() actor: JwtClaims, @Query() query: AdvisorSearchDto) { return this.service.advisors(actor.sub, query); }
}

@Controller('advisor-links')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR')
export class AdvisorRequestsController {
  constructor(private readonly service: AdvisorLinkService) {}

  @Get('requests')
  requests(@CurrentUser() actor: JwtClaims, @Query() query: AdvisorSearchDto) { return this.service.requests(actor.sub, query); }

  @Post('requests/:student_id/actions/:action') @HttpCode(204)
  action(@CurrentUser() actor: JwtClaims, @Param('student_id', ParseUUIDPipe) studentId: string,
    @Param('action') action: string, @Headers('x-correlation-id') correlationId: string) {
    return this.service.action(actor.sub, studentId, action, correlationId);
  }

  @Get('students')
  students(@CurrentUser() actor: JwtClaims, @Query() query: AdvisorSearchDto) { return this.service.students(actor.sub, query); }
}

@Controller('admin')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminAdvisorsController {
  constructor(private readonly service: AdvisorLinkService) {}

  @Get('advisors')
  advisors(@CurrentUser() actor: JwtClaims, @Query() query: AdminAdvisorQueryDto) { return this.service.adminAdvisors(actor.sub, query); }

  @Post('advisors/:id/actions/:action') @HttpCode(204)
  advisorAction(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) id: string,
    @Param('action') action: string, @Body() body: AdvisorActionDto,
    @Headers('x-correlation-id') correlationId: string) {
    return this.service.adminAdvisorAction(actor.sub, id, action, body.reason, correlationId);
  }

  @Post('students/:id/advisor') @HttpCode(204)
  moveStudent(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) studentId: string,
    @Body() body: AdvisorIdDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.adminMove(actor.sub, studentId, body.advisor_id, correlationId);
  }
}
