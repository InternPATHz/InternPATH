import { Module } from '@nestjs/common';
import { CompanyModule } from '../../company/company.module';
import { CompanyEntitlementChangedConsumer } from './company-entitlement-changed.consumer';
import { CompanyFlagChangedConsumer } from './company-flag-changed.consumer';
import { CompanyStatusChangedConsumer } from './company-status-changed.consumer';
import { JobVerifiedConsumer } from './job-verified.consumer';
import { ReportThresholdReachedConsumer } from './report-threshold-reached.consumer';
import { UserDeletionRequestedConsumer } from './user-deletion-requested.consumer';
import { StatusModule } from '../../status/status.module';

@Module({
  imports: [CompanyModule, StatusModule],
  providers: [
    CompanyStatusChangedConsumer,
    CompanyEntitlementChangedConsumer,
    CompanyFlagChangedConsumer,
    JobVerifiedConsumer,
    ReportThresholdReachedConsumer,
    UserDeletionRequestedConsumer,
  ],
})
export class ConsumersModule {}
