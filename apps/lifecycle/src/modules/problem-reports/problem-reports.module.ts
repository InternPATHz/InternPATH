import { Module } from '@nestjs/common';
import { AdvisorProblemReportsController, ProblemReportActionsController } from './problem-report-review.controller';
import { StudentProblemReportsController } from './problem-reports.controller';
import { ProblemReportsService } from './problem-reports.service';

/** รายงานปัญหาระหว่างฝึกงาน — นักศึกษา (1.4), อาจารย์/Admin รับเรื่อง (1.6); รายการของ Admin เพิ่มใน 1.9 */
@Module({
  controllers: [StudentProblemReportsController, AdvisorProblemReportsController, ProblemReportActionsController],
  providers: [ProblemReportsService],
  exports: [ProblemReportsService],
})
export class ProblemReportsModule {}
