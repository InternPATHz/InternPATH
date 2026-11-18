import { Body, Controller, Headers, Param, ParseUUIDPipe, Post, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { ProblemReportItem } from '@internpath/contracts';
import { CreateProblemReportDto } from '../applications/applications.dto';
import { ProblemReportsService } from './problem-reports.service';

/** api-contract §7.2 — นักศึกษารายงานปัญหาระหว่างฝึกงาน (เฉพาะ `IN_PROGRESS`) • ไม่มี endpoint ฝั่ง HR โดยตั้งใจ (README §5.11) */
@Controller('applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class StudentProblemReportsController {
  constructor(private readonly service: ProblemReportsService) {}

  @Post(':id/problem-reports')
  create(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateProblemReportDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ProblemReportItem> {
    return this.service.create(user.sub, id, body, cid);
  }
}
