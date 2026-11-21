import {
  CORRELATION_HEADER,
  CurrentUser,
  JwtAuthGuard,
  JwtClaims,
  Roles,
  RolesGuard,
} from '@internpath/common';
import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Put,
  Query,
  UseGuards,
} from '@nestjs/common';
import { FeaturedDto, HrJobsQueryDto, WriteJobDto } from './dto';
import { HrJobsService } from './hr-jobs.service';

@Controller('hr/jobs')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrJobsController {
  constructor(private readonly jobs: HrJobsService) {}

  @Get()
  list(@CurrentUser() user: JwtClaims, @Query() query: HrJobsQueryDto) {
    return this.jobs.list(user, query);
  }

  @Post()
  create(@CurrentUser() user: JwtClaims, @Body() body: WriteJobDto) {
    return this.jobs.create(user, body);
  }

  @Get(':id')
  detail(@CurrentUser() user: JwtClaims, @Param('id') id: string) {
    return this.jobs.detail(user, id);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: JwtClaims,
    @Param('id') id: string,
    @Body() body: WriteJobDto,
    @Headers(CORRELATION_HEADER) correlationId: string,
  ) {
    return this.jobs.update(user, id, body, correlationId);
  }

  @Post(':id/actions/submit')
  @HttpCode(200)
  submit(
    @CurrentUser() user: JwtClaims,
    @Param('id') id: string,
    @Headers(CORRELATION_HEADER) correlationId: string,
  ) {
    return this.jobs.submit(user, id, correlationId);
  }

  @Post(':id/actions/close')
  @HttpCode(200)
  close(
    @CurrentUser() user: JwtClaims,
    @Param('id') id: string,
    @Headers(CORRELATION_HEADER) correlationId: string,
  ) {
    return this.jobs.setClosed(user, id, true, correlationId);
  }

  @Post(':id/actions/reopen')
  @HttpCode(200)
  reopen(
    @CurrentUser() user: JwtClaims,
    @Param('id') id: string,
    @Headers(CORRELATION_HEADER) correlationId: string,
  ) {
    return this.jobs.setClosed(user, id, false, correlationId);
  }

  @Put(':id/featured')
  featured(@CurrentUser() user: JwtClaims, @Param('id') id: string, @Body() body: FeaturedDto) {
    return this.jobs.setFeatured(user, id, body.enabled);
  }
}
