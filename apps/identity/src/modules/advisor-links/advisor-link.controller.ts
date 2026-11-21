import { Body, Controller, Delete, Get, Headers, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { AdvisorActionDto, AdvisorIdDto, AdvisorStudentsQueryDto, AdminAdvisorQueryDto, CreateStudentDto, UpdateStudentDto } from './advisor-link.dto';
import { AdvisorLinkService } from './advisor-link.service';

/** อาจารย์เพิ่ม/จัดการนักศึกษาในความดูแล (ปรับ Requirement 2026-11-21: นักศึกษาไม่สมัครเอง) */
@Controller('advisor-links/students')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR')
export class AdvisorStudentsController {
  constructor(private readonly service: AdvisorLinkService) {}

  @Post()
  create(@CurrentUser() actor: JwtClaims, @Body() body: CreateStudentDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.createStudent(actor.sub, body, correlationId);
  }

  @Get()
  list(@CurrentUser() actor: JwtClaims, @Query() query: AdvisorStudentsQueryDto) { return this.service.students(actor.sub, query); }

  @Patch(':student_id') @HttpCode(204)
  update(@CurrentUser() actor: JwtClaims, @Param('student_id', ParseUUIDPipe) studentId: string, @Body() body: UpdateStudentDto) {
    return this.service.updateStudent(actor.sub, studentId, body);
  }

  @Post(':student_id/actions/resend-invitation') @HttpCode(204)
  resend(@CurrentUser() actor: JwtClaims, @Param('student_id', ParseUUIDPipe) studentId: string) {
    return this.service.resendInvitation(actor.sub, studentId);
  }

  @Delete(':student_id/invitation') @HttpCode(204)
  cancel(@CurrentUser() actor: JwtClaims, @Param('student_id', ParseUUIDPipe) studentId: string, @Headers('x-correlation-id') correlationId: string) {
    return this.service.cancelInvitation(actor.sub, studentId, correlationId);
  }
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

  /** เปลี่ยนอาจารย์ของนักศึกษา — Admin เท่านั้น (อาจารย์/นักศึกษาเปลี่ยนเองไม่ได้) */
  @Post('students/:id/advisor') @HttpCode(204)
  moveStudent(@CurrentUser() actor: JwtClaims, @Param('id', ParseUUIDPipe) studentId: string,
    @Body() body: AdvisorIdDto, @Headers('x-correlation-id') correlationId: string) {
    return this.service.adminMove(actor.sub, studentId, body.advisor_id, correlationId);
  }
}
