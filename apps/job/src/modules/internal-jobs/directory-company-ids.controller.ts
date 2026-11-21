import { InternalCallers, ServiceTokenGuard, ServiceTokenPolicy } from '@internpath/common';
import type { JobCategory } from '@internpath/contracts';
import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { JobCategory as JobCategoryEnum } from '../../../generated/client';
import { DirectoryCompanyIdsService } from './directory-company-ids.service';

class CompanyIdsQuery {
  @IsEnum(JobCategoryEnum)
  category!: JobCategory;

  @IsOptional()
  @IsUUID()
  after?: string;
}

@Controller('internal/v1/directory/company-ids')
@UseGuards(ServiceTokenGuard)
@ServiceTokenPolicy({ audience: 'job', secretEnvByCaller: { identity: 'JOB_SERVICE_SECRET_IDENTITY' } })
@InternalCallers('identity')
export class DirectoryCompanyIdsController {
  constructor(private readonly service: DirectoryCompanyIdsService) {}

  @Get()
  list(@Query() query: CompanyIdsQuery) {
    return this.service.list(query.category, query.after?.toLowerCase());
  }
}
