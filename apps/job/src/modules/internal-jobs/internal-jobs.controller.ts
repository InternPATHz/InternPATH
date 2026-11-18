import { InternalCallers, ServiceTokenGuard, ServiceTokenPolicy } from '@internpath/common';
import type {
  InternalJobResponse,
  QuotaApplicationRequest,
  QuotaReleaseRequest,
  QuotaReserveResponse,
} from '@internpath/contracts';
import { Body, Controller, Get, HttpCode, Param, Post, UseGuards } from '@nestjs/common';
import { IsString, IsUUID, Matches } from 'class-validator';
import { InternalJobsService } from './internal-jobs.service';
import { QuotaService } from './quota.service';

class JobIdParams {
  @IsUUID()
  job_id!: string;
}

class QuotaApplicationDto implements QuotaApplicationRequest {
  @IsUUID()
  application_id!: string;
}

class QuotaReleaseDto extends QuotaApplicationDto implements QuotaReleaseRequest {
  @IsString()
  @Matches(/\S/u)
  reason!: string;
}

@Controller('internal/v1/jobs')
@UseGuards(ServiceTokenGuard)
@ServiceTokenPolicy({
  audience: 'job',
  secretEnvByCaller: { lifecycle: 'JOB_SERVICE_SECRET_LIFECYCLE' },
})
@InternalCallers('lifecycle')
export class InternalJobsController {
  constructor(
    private readonly jobs: InternalJobsService,
    private readonly quota: QuotaService,
  ) {}

  @Get(':job_id')
  detail(@Param() { job_id }: JobIdParams): Promise<InternalJobResponse> {
    return this.jobs.detail(job_id.toLowerCase());
  }

  @Post(':job_id/quota/reserve')
  @HttpCode(200)
  async reserve(
    @Param() { job_id }: JobIdParams,
    @Body() body: QuotaApplicationDto,
  ): Promise<QuotaReserveResponse> {
    await this.quota.reserve(job_id.toLowerCase(), body.application_id.toLowerCase());
    return { reserved: true };
  }

  @Post(':job_id/quota/confirm')
  @HttpCode(204)
  confirm(@Param() { job_id }: JobIdParams, @Body() body: QuotaApplicationDto): Promise<void> {
    return this.quota.confirm(job_id.toLowerCase(), body.application_id.toLowerCase());
  }

  @Post(':job_id/quota/release')
  @HttpCode(200)
  async release(
    @Param() { job_id }: JobIdParams,
    @Body() body: QuotaReleaseDto,
  ): Promise<Record<string, never>> {
    await this.quota.release(job_id.toLowerCase(), body.application_id.toLowerCase(), body.reason);
    return {};
  }
}
