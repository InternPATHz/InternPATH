import { Module } from '@nestjs/common';
import { StudentProblemReportsController } from './problem-reports.controller';
import { ProblemReportsService } from './problem-reports.service';

/** รายงานปัญหาระหว่างฝึกงาน — ฝั่งนักศึกษา (1.4); ฝั่งอาจารย์/Admin เพิ่มใน 1.6/1.9 */
@Module({
  controllers: [StudentProblemReportsController],
  providers: [ProblemReportsService],
  exports: [ProblemReportsService],
})
export class ProblemReportsModule {}
