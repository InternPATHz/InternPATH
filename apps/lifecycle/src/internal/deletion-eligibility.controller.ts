import { Controller, Get, Injectable, Module, Param, ParseUUIDPipe, UseGuards } from '@nestjs/common';
import { InternalCallers, ServiceTokenGuard, ServiceTokenPolicy } from '@internpath/common';
import type { DeletionEligibilityResponse } from '@internpath/contracts';
import { PrismaService } from '../prisma/prisma.service';
import { DELETION_BLOCKING_STATUSES } from '../state-machine/transition-table';

/** secret ที่ Identity ใช้เรียก Lifecycle — มีใน `.env.example` แล้ว (api-contract §9, PM ตัดสิน 2026-11-17) */
export const IDENTITY_CALLER_SECRET_ENV = 'LIFECYCLE_SERVICE_SECRET_IDENTITY';

@Injectable()
export class DeletionEligibilityService {
  constructor(private readonly db: PrismaService) {}

  /**
   * `eligible=false` เมื่อผู้ใช้มีใบสมัครใน `DELETION_BLOCKING_STATUSES` (ADVISOR_PENDING → REEVALUATION_REQUESTED)
   * ไม่มีใบสมัคร / ไม่รู้จักผู้ใช้ ⇒ `eligible=true` • ใบ `PENDING`/`HR_ACCEPTED` ไม่บล็อก (ถูก `CANCELLED` ตอนรับ E15)
   */
  async check(userId: string): Promise<DeletionEligibilityResponse> {
    const count = await this.db.application.count({
      where: { studentUserId: userId, status: { in: [...DELETION_BLOCKING_STATUSES] } },
    });
    return { eligible: count === 0, blocking_application_count: count };
  }
}

/**
 * `GET /internal/v1/users/{user_id}/deletion-eligibility` (ไม่ผ่าน Gateway) — Service Token ของ Identity เท่านั้น
 * Identity ปฏิเสธการลบเมื่อเรียกไม่สำเร็จ (fail-closed ฝั่ง Identity)
 */
@Controller('internal/v1')
@UseGuards(ServiceTokenGuard)
@ServiceTokenPolicy({ audience: 'lifecycle', secretEnvByCaller: { identity: IDENTITY_CALLER_SECRET_ENV } })
export class DeletionEligibilityController {
  constructor(private readonly service: DeletionEligibilityService) {}

  @Get('users/:user_id/deletion-eligibility')
  @InternalCallers('identity')
  check(@Param('user_id', ParseUUIDPipe) userId: string): Promise<DeletionEligibilityResponse> {
    return this.service.check(userId);
  }
}

@Module({
  controllers: [DeletionEligibilityController],
  providers: [DeletionEligibilityService],
})
export class DeletionEligibilityModule {}
