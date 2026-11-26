import { Module } from '@nestjs/common';
import { AdvisorConductReportsController, HrConductReportsController } from './conduct-reports.controller';
import { ConductReportsService } from './conduct-reports.service';

/** รายงานพฤติกรรมนักศึกษาจากบริษัทถึงอาจารย์ (HR ส่ง, อาจารย์รับทราบ) */
@Module({
  controllers: [HrConductReportsController, AdvisorConductReportsController],
  providers: [ConductReportsService],
})
export class ConductReportsModule {}
