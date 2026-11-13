import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { JwtAuthGuard, Roles, RolesGuard } from '@internpath/common';
import type { Page } from '../common/pagination';
import { AuditQuery, AuditRow, AuditService } from './audit.service';

@Controller('admin/audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AuditController {
  constructor(private readonly audit: AuditService) {}

  /** บันทึกการกระทำของ Admin ย้อนหลัง (OD-04) */
  @Get()
  list(@Query() q: AuditQuery): Promise<Page<AuditRow>> {
    return this.audit.list(q);
  }
}
