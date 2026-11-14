import { Module } from '@nestjs/common';
import { AppException } from '@internpath/common';
import { AccountDeletionService, DELETION_ELIGIBILITY, type DeletionEligibility } from './account-deletion.service';

const unavailableEligibility: DeletionEligibility = {
  assertNoActiveApplications: async () => {
    throw new AppException('UPSTREAM_UNAVAILABLE', 'ยังตรวจสถานะใบสมัครไม่ได้', 503);
  },
};

@Module({
  providers: [AccountDeletionService, { provide: DELETION_ELIGIBILITY, useValue: unavailableEligibility }],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
