import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type {
  ApplicationEligibilityResponse,
  Paginated,
  StudentApplicationDetail,
  StudentApplicationItem,
} from '@internpath/contracts';
import { CreateApplicationDto, DisputeFailDto, MyApplicationsQueryDto, ReasonDto } from './applications.dto';
import { ApplicationsService } from './applications.service';

/** api-contract §7.2 — สร้างใบสมัครและ action ของนักศึกษา (`/applications/...`) */
@Controller('applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class StudentApplicationsController {
  constructor(private readonly service: ApplicationsService) {}

  @Post()
  create(
    @CurrentUser() user: JwtClaims,
    @Body() body: CreateApplicationDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentApplicationItem> {
    return this.service.create(user.sub, body, cid);
  }

  @Post(':id/actions/confirm-offer')
  @HttpCode(200)
  confirmOffer(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentApplicationDetail> {
    return this.service.transition(user.sub, id, 'confirm-offer', undefined, cid);
  }

  @Post(':id/actions/decline-offer')
  @HttpCode(200)
  declineOffer(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentApplicationDetail> {
    return this.service.transition(user.sub, id, 'decline-offer', undefined, cid);
  }

  @Post(':id/actions/withdraw')
  @HttpCode(200)
  withdraw(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentApplicationDetail> {
    return this.service.transition(user.sub, id, 'withdraw', body.reason, cid);
  }

  @Post(':id/actions/request-termination')
  @HttpCode(200)
  requestTermination(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentApplicationDetail> {
    return this.service.transition(user.sub, id, 'request-termination', body.reason, cid);
  }

  @Post(':id/actions/dispute-fail')
  @HttpCode(200)
  disputeFail(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisputeFailDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentApplicationDetail> {
    return this.service.disputeFail(user.sub, id, body.statement, cid);
  }
}

/** api-contract §7.2 — ใบสมัครของนักศึกษาที่ล็อกอินอยู่ (`/me/...`) */
@Controller('me')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class MyApplicationsController {
  constructor(private readonly service: ApplicationsService) {}

  @Get('applications')
  list(@CurrentUser() user: JwtClaims, @Query() query: MyApplicationsQueryDto): Promise<Paginated<StudentApplicationItem>> {
    return this.service.list(user.sub, query.status, query.page, query.page_size);
  }

  @Get('applications/:id')
  detail(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<StudentApplicationDetail> {
    return this.service.detail(user.sub, id);
  }

  @Get('application-eligibility')
  eligibility(
    @CurrentUser() user: JwtClaims,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ApplicationEligibilityResponse> {
    return this.service.eligibility(user.sub, cid);
  }
}
