import { Controller, Get, Header, Param, Query, Res } from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { PublicJobsService } from './public-jobs.service';
import { SearchJobsQueryDto } from './search-jobs-query.dto';

const PUBLIC_CACHE_CONTROL = 'public, max-age=60';

@Controller()
export class PublicJobsController {
  constructor(private readonly jobs: PublicJobsService) {}

  @Get('search/jobs')
  @Header('Cache-Control', PUBLIC_CACHE_CONTROL)
  search(@Query() query: SearchJobsQueryDto) {
    return this.jobs.search(query);
  }

  @Get('jobs/:id')
  async detail(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Pick<ServerResponse, 'setHeader'>,
  ) {
    const job = await this.jobs.detail(id);
    response.setHeader('Cache-Control', PUBLIC_CACHE_CONTROL);
    if (job.status === 'CLOSED') response.setHeader('X-Robots-Tag', 'noindex');
    return job;
  }
}
