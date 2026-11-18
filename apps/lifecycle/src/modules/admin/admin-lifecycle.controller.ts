import { Body, Controller, Get, Headers, HttpCode, Param, ParseUUIDPipe, Post, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type {
  ApplicationBase,
  AuditLogEntry,
  CompanyLifecycleStats,
  NoEvaluationCandidate,
  Paginated,
  ProblemReportItem,
} from '@internpath/contracts';
import { ProblemReportsService } from '../problem-reports/problem-reports.service';
import {
  AdminProblemReportsQueryDto,
  AdminReasonDto,
  AuditLogsQueryDto,
  NoEvaluationCandidatesQueryDto,
} from './admin.dto';
import { AdminLifecycleService, type ReapplyUnlockItem } from './admin-lifecycle.service';

/**
 * api-contract §7.7 — Admin ของ Lifecycle (เฉพาะ `PLATFORM_ADMIN`; Role อื่น ⇒ `403 FORBIDDEN_ROLE`)
 * `POST certificates/{id}/actions/revoke` อยู่ที่ `AdminCertificatesController` (1.7)
 */
@Controller('admin/lifecycle')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminLifecycleController {
  constructor(
    private readonly service: AdminLifecycleService,
    private readonly problemReports: ProblemReportsService,
  ) {}

  @Get('no-evaluation-candidates')
  noEvaluationCandidates(@Query() query: NoEvaluationCandidatesQueryDto): Promise<Paginated<NoEvaluationCandidate>> {
    return this.service.noEvaluationCandidates(query.status, query.page, query.page_size);
  }

  @Post('applications/:id/actions/confirm-no-evaluation')
  @HttpCode(200)
  confirmNoEvaluation(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ApplicationBase> {
    return this.service.confirmNoEvaluation(user, id, body.reason, cid);
  }

  @Post('applications/:id/actions/terminate')
  @HttpCode(200)
  terminate(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AdminReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ApplicationBase> {
    return this.service.terminate(user, id, body.reason, cid);
  }

  @Post('students/:user_id/reapply-unlock')
  @HttpCode(201)
  reapplyUnlock(
    @CurrentUser() user: JwtClaims,
    @Param('user_id', ParseUUIDPipe) studentUserId: string,
    @Body() body: AdminReasonDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ReapplyUnlockItem> {
    return this.service.reapplyUnlock(user, studentUserId, body.reason, cid);
  }

  @Get('problem-reports')
  listProblemReports(@Query() query: AdminProblemReportsQueryDto): Promise<Paginated<ProblemReportItem>> {
    return this.problemReports.listForAdmin({ status: query.status, overdue: query.overdue }, query.page, query.page_size);
  }

  @Get('company-stats/:company_id')
  companyStats(@Param('company_id', ParseUUIDPipe) companyId: string): Promise<CompanyLifecycleStats> {
    return this.service.companyStats(companyId);
  }

  @Get('audit-logs')
  auditLogs(@Query() query: AuditLogsQueryDto): Promise<Paginated<AuditLogEntry>> {
    return this.service.auditLogs(query);
  }
}
