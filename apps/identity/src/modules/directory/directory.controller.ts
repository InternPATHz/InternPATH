import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { DirectoryQueryDto } from './directory.dto';
import { DirectoryService } from './directory.service';

/**
 * api-contract §4.4 — Public reads (no JWT guard). The Gateway skips JWT for these GET routes,
 * so the response must not depend on who is calling.
 */
@Controller('directory/companies')
export class DirectoryController {
  constructor(private readonly service: DirectoryService) {}

  @Get()
  list(@Query() query: DirectoryQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
}
