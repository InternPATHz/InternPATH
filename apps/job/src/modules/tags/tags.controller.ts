import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { Body, Controller, Get, Header, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminTagListQuery, CreateTagDto, TagListQuery, UpdateTagDto } from './dto';
import { TagsService } from './tags.service';

/** `GET /tags` — Public (HR ใช้เลือก Tag ตอนสร้างประกาศ; นักศึกษาใช้กรองการค้นหา) */
@Controller('tags')
export class TagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  list(@Query() q: TagListQuery) {
    return this.tags.listActive(q);
  }
}

/** `/admin/tags` — เฉพาะ Admin (api-contract §5.4) */
@Controller('admin/tags')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('PLATFORM_ADMIN')
export class AdminTagsController {
  constructor(private readonly tags: TagsService) {}

  @Get()
  list(@Query() q: AdminTagListQuery) {
    return this.tags.listAdmin(q);
  }

  @Post()
  create(@Body() dto: CreateTagDto, @CurrentUser() user: JwtClaims) {
    return this.tags.create(dto.name, user.sub);
  }

  @Patch(':id')
  update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdateTagDto, @CurrentUser() user: JwtClaims) {
    return this.tags.update(id, dto, user.sub);
  }
}
