import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post, Req, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard, getCorrelationId } from '@internpath/common';
import type { Request } from 'express';
import { ReportResolutionDto } from './dto';
import { ReportResolutionService } from './report-resolution.service';

/** action ตัดสินรายงานประกาศ — แยกจาก QueueController เพื่อไม่ให้ QueueModule ต้องพึ่ง ReportModule (circular) */
@Controller('admin/queue')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class ReportActionsController {
  constructor(private readonly resolution: ReportResolutionService) {}

  /** ยกคำร้อง: ประกาศที่ระงับกลับเป็น PUBLISHED (RESTORE) + รีเซ็ตตัวนับ */
  @Post(':id/actions/dismiss-report')
  @HttpCode(204)
  dismiss(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportResolutionDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<void> {
    return this.resolution.dismiss(id, { sub: user.sub }, dto.reason || undefined, getCorrelationId(req));
  }

  /** ยืนยันรายงาน: ประกาศที่ระงับถูกลบถาวร (REMOVE) */
  @Post(':id/actions/uphold-report')
  @HttpCode(204)
  uphold(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ReportResolutionDto,
    @CurrentUser() user: JwtClaims,
    @Req() req: Request,
  ): Promise<void> {
    return this.resolution.uphold(id, { sub: user.sub }, dto.reason || undefined, getCorrelationId(req));
  }
}
