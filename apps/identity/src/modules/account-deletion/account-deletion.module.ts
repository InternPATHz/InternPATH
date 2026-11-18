import { Module } from '@nestjs/common';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionService, DELETION_ELIGIBILITY } from './account-deletion.service';
import { LifecycleDeletionEligibility } from './lifecycle-eligibility.client';

/**
 * ลบบัญชี (README §5.11) — ตรวจสิทธิ์กับ Lifecycle ผ่าน `LifecycleDeletionEligibility` (fail-closed เมื่อเรียกไม่ได้)
 * แทน provider ชั่วคราวที่ปฏิเสธทุกคำขอ (developer-guide §7)
 */
@Module({
  controllers: [AccountDeletionController],
  providers: [
    AccountDeletionService,
    LifecycleDeletionEligibility,
    { provide: DELETION_ELIGIBILITY, useExisting: LifecycleDeletionEligibility },
  ],
  exports: [AccountDeletionService],
})
export class AccountDeletionModule {}
