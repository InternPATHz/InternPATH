import { Module } from '@nestjs/common';
import { CompanyModule } from '../../company/company.module';
import { CompanyEntitlementChangedConsumer } from './company-entitlement-changed.consumer';
import { CompanyFlagChangedConsumer } from './company-flag-changed.consumer';
import { CompanyStatusChangedConsumer } from './company-status-changed.consumer';

@Module({
  imports: [CompanyModule],
  providers: [
    CompanyStatusChangedConsumer,
    CompanyEntitlementChangedConsumer,
    CompanyFlagChangedConsumer,
  ],
})
export class ConsumersModule {}
