import { Controller, Get, Param, ParseUUIDPipe, Query, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { DirectoryQueryDto } from './directory.dto';
import { DirectoryService } from './directory.service';

@Controller('directory/companies')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT', 'ADVISOR', 'COMPANY_HR', 'PLATFORM_ADMIN')
export class DirectoryController {
  constructor(private readonly service: DirectoryService) {}

  @Get()
  list(@CurrentUser() viewer: JwtClaims, @Query() query: DirectoryQueryDto) {
    return this.service.list(viewer.sub, query);
  }

  @Get(':id')
  detail(@CurrentUser() viewer: JwtClaims, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(viewer.sub, id);
  }
}
