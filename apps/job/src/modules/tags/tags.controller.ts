import { CurrentUser, JwtAuthGuard, JwtClaims, Roles, RolesGuard } from '@internpath/common';
import { Body, Controller, Delete, Get, Header, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { AdminTagListQuery, CreateTagDto, MergeTagDto, TagListQuery, UpdateTagDto } from './dto';
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

  /** รวม Tag ซ้ำ: ย้ายประกาศทุกใบจาก `{id}` ไป `into_tag_id` แล้วลบ `{id}` → 200 Tag ปลายทาง */
  @Post(':id/merge')
  @HttpCode(200)
  merge(@Param('id', ParseUUIDPipe) id: string, @Body() dto: MergeTagDto, @CurrentUser() user: JwtClaims) {
    return this.tags.merge(id, dto.into_tag_id, user.sub);
  }

  /** ลบได้เฉพาะ Tag ที่ไม่มีประกาศใช้ — ถูกใช้แล้ว ⇒ 409 `TAG_IN_USE` (ให้ปิดใช้งานแทน) */
  @Delete(':id')
  @HttpCode(204)
  remove(@Param('id', ParseUUIDPipe) id: string) {
    return this.tags.remove(id);
  }
}
