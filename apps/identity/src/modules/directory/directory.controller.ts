import { Controller, Get, Header, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { DirectoryQueryDto } from './directory.dto';
import { DirectoryService } from './directory.service';

/**
 * api-contract §4.4 — Public (PM ตัดสิน 2026-11-18)
 * - **ห้ามใส่ `JwtAuthGuard`/`RolesGuard`** — Gateway ข้าม JWT ให้ path นี้ ถ้า Service บังคับ ผู้เยี่ยมชมจะได้ 401
 * - Response เหมือนกันทุกผู้เรียก ไม่อ่านตัวตนผู้เรียก (ไม่มี `@CurrentUser`) • `Cache-Control: public, max-age=60`
 * - Rate limit 60 ครั้ง/นาที/IP ทำที่ Gateway
 */
@Controller('directory/companies')
export class DirectoryController {
  constructor(private readonly service: DirectoryService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=60')
  list(@Query() query: DirectoryQueryDto) {
    return this.service.list(query);
  }

  @Get(':id')
  @Header('Cache-Control', 'public, max-age=60')
  detail(@Param('id', ParseUUIDPipe) id: string) {
    return this.service.detail(id);
  }
}
