import { Body, Controller, HttpCode, Injectable, Module, Post, UseGuards } from '@nestjs/common';
import { InternalCallers, ServiceTokenGuard, ServiceTokenPolicy } from '@internpath/common';
import type { ReservationCheckRequest, ReservationCheckResponse } from '@internpath/contracts';
import { ArrayMaxSize, IsArray, IsUUID } from 'class-validator';
import { PrismaService } from '../prisma/prisma.service';

/** ขนาด Batch สูงสุดต่อคำขอ (Job เรียกทุก 30 นาที — ใบสมัครที่จองค้างเกิน 15 นาที) */
export const RESERVATION_CHECK_MAX_IDS = 500;

/**
 * secret ของ Job ที่เรียก Lifecycle — ชื่อตามรูปแบบ `LIFECYCLE_SERVICE_SECRET_IDENTITY` (api-contract §9)
 * **ยังไม่มีใน `.env.example`** ⇒ ขอ PM เพิ่ม; ไม่ได้ตั้ง/สั้นกว่า 32 ตัว ⇒ Guard ปฏิเสธทุกคำขอ (fail-closed)
 */
export const JOB_CALLER_SECRET_ENV = 'LIFECYCLE_SERVICE_SECRET_JOB';

export class ReservationCheckDto implements ReservationCheckRequest {
  @IsArray()
  @ArrayMaxSize(RESERVATION_CHECK_MAX_IDS)
  @IsUUID('all', { each: true })
  application_ids!: string[];
}

@Injectable()
export class ReservationCheckService {
  constructor(private readonly db: PrismaService) {}

  /**
   * Lifecycle ชี้ขาด (README §5.8): ถือโควตาต่อเมื่อ `quota_reserved = true`
   * (ตั้งตอน `HR_ACCEPTED`, คงไว้หลัง confirm ตอน `IN_PROGRESS`, ล้างเมื่อ release) • ไม่พบใบสมัคร ⇒ `false`
   * คืนตามลำดับคำขอ (id ซ้ำคืนซ้ำ)
   */
  async check(applicationIds: readonly string[]): Promise<ReservationCheckResponse> {
    const unique = [...new Set(applicationIds)];
    const rows = unique.length
      ? await this.db.application.findMany({ where: { id: { in: unique } }, select: { id: true, quotaReserved: true } })
      : [];
    const held = new Map(rows.map((r) => [r.id, r.quotaReserved]));
    return applicationIds.map((id) => ({ application_id: id, should_hold_quota: held.get(id) === true }));
  }
}

/** api-contract §9 — `POST /internal/v1/applications/reservation-check` (ไม่ผ่าน Gateway; Service Token ของ Job เท่านั้น) */
@Controller('internal/v1')
@UseGuards(ServiceTokenGuard)
@ServiceTokenPolicy({ audience: 'lifecycle', secretEnvByCaller: { job: JOB_CALLER_SECRET_ENV } })
export class ReservationCheckController {
  constructor(private readonly service: ReservationCheckService) {}

  @Post('applications/reservation-check')
  @HttpCode(200)
  @InternalCallers('job')
  check(@Body() body: ReservationCheckDto): Promise<ReservationCheckResponse> {
    return this.service.check(body.application_ids);
  }
}

@Module({
  controllers: [ReservationCheckController],
  providers: [ReservationCheckService],
})
export class ReservationCheckModule {}
