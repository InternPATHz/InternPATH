import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { AdvisorApplicationItem, AdvisorDisputeItem, AdvisorStudentOverview, AdvisorTrainingStudentItem, Paginated } from '@internpath/contracts';
import { PageQueryDto } from '../resumes/resumes.dto';
import { AcademicResultDto, AdvisorApplicationsQueryDto, AdvisorReasonDto, AdvisorStudentsQueryDto, DisputeDecisionDto } from './advisor.dto';
import { AdvisorService } from './advisor.service';

/**
 * api-contract §7.4 — อาจารย์ที่ปรึกษา (`/advisor/...`)
 * รายงานปัญหา (`/advisor/problem-reports`, `/problem-reports/{id}/actions/...`) อยู่ใน ProblemReportsModule
 */
@Controller('advisor')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR')
export class AdvisorController {
  constructor(private readonly service: AdvisorService) {}

  @Get('applications')
  list(@CurrentUser() user: JwtClaims, @Query() query: AdvisorApplicationsQueryDto): Promise<Paginated<AdvisorApplicationItem>> {
    return this.service.list(user, query);
  }

  @Get('disputes')
  disputes(@CurrentUser() user: JwtClaims, @Query() query: PageQueryDto): Promise<Paginated<AdvisorDisputeItem>> {
    return this.service.disputes(user, query.page, query.page_size);
  }

  /** รายชื่อนักศึกษาในความดูแล + ตัวกรองชั้นปี/กำลังฝึก/ฝึกเสร็จแล้ว (ต้องประกาศก่อน `students/:id/overview`) */
  @Get('students')
  students(
    @CurrentUser() user: JwtClaims,
    @Query() query: AdvisorStudentsQueryDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<Paginated<AdvisorTrainingStudentItem>> {
    return this.service.students(user, query, cid);
  }

  @Get('students/:id/overview')
  overview(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<AdvisorStudentOverview> {
    return this.service.overview(user, id);
  }

  @Post('applications/:id/actions/approve')
  @HttpCode(200)
  approve(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<AdvisorApplicationItem> {
    return this.service.approve(user, id, cid);
  }

  @Post('applications/:id/actions/reject')
  @HttpCode(200)
  reject(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdvisorReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<AdvisorApplicationItem> {
    return this.service.reject(user, id, body.reason, cid);
  }

  @Post('applications/:id/actions/request-reevaluation')
  @HttpCode(200)
  requestReevaluation(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisputeDecisionDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<AdvisorApplicationItem> {
    return this.service.decideDispute(user, id, 'request-reevaluation', body.note, cid);
  }

  @Post('applications/:id/actions/uphold-fail')
  @HttpCode(200)
  upholdFail(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: DisputeDecisionDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<AdvisorApplicationItem> {
    return this.service.decideDispute(user, id, 'uphold-fail', body.note, cid);
  }

  @Post('applications/:id/academic-result')
  @HttpCode(200)
  academicResult(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AcademicResultDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<AdvisorApplicationItem> {
    return this.service.academicResult(user, id, body, cid);
  }

  @Post('applications/:id/actions/continue')
  @HttpCode(200)
  continueInternship(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<AdvisorApplicationItem> {
    return this.service.continueInternship(user, id);
  }

  @Post('applications/:id/actions/terminate')
  @HttpCode(200)
  terminate(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdvisorReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<AdvisorApplicationItem> {
    return this.service.terminate(user, id, body.reason, cid);
  }
}
