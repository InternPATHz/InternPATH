import { JwtAuthGuard, Roles, RolesGuard } from '@internpath/common';
import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import { AdminJobsQueryDto } from './admin-jobs.dto';
import { AdminJobsService } from './admin-jobs.service';

@Controller('admin/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminJobsController {
  constructor(private readonly jobs: AdminJobsService) {}

  @Get()
  @Header('Cache-Control', 'private, no-store')
  list(@Query() query: AdminJobsQueryDto) {
    return this.jobs.list(query);
  }
}
