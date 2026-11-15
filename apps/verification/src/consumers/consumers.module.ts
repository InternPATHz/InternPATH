import { Module } from '@nestjs/common';
import { AnonymizationModule } from '../anonymization/anonymization.module';
import { CompanyModule } from '../company/company.module';
import { EvaluationModule } from '../evaluation/evaluation.module';
import { JobModule } from '../job/job.module';
import { CompanyStatusChangedConsumer } from './company-status-changed.consumer';
import { JobStatusChangedConsumer } from './job-status-changed.consumer';
import { JobSubmittedConsumer } from './job-submitted.consumer';
import { UserDeletionRequestedConsumer } from './user-deletion-requested.consumer';

/** ตัวรับ Event ทั้งหมดของ Service — โหลดเฉพาะใน VerificationModule (ต้องมี MessagingModule) ไม่ใช้ในเทสต์ที่ไม่มี Broker */
@Module({
  imports: [EvaluationModule, CompanyModule, JobModule, AnonymizationModule],
  providers: [JobSubmittedConsumer, JobStatusChangedConsumer, CompanyStatusChangedConsumer, UserDeletionRequestedConsumer],
})
export class ConsumersModule {}
