import {
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UploadedFile,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { Paginated, ResumeItem, ResumeUrlResponse } from '@internpath/contracts';
import { RESUME_FILE_FIELD, RESUME_MAX_BYTES } from './resume-file';
import { PageQueryDto } from './resumes.dto';
import { ResumesService } from './resumes.service';
import { UploadErrorInterceptor } from './upload-error.interceptor';

/** api-contract §7.1 — เรซูเม่ของนักศึกษาที่ล็อกอินอยู่ */
@Controller('me/resumes')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class MyResumesController {
  constructor(private readonly service: ResumesService) {}

  /** multipart/form-data ฟิลด์ `file` — multer เก็บในหน่วยความจำ และตัดที่ 5 MB */
  @Post()
  @UseInterceptors(
    UploadErrorInterceptor,
    FileInterceptor(RESUME_FILE_FIELD, { limits: { fileSize: RESUME_MAX_BYTES, files: 1 } }),
  )
  upload(@CurrentUser() user: JwtClaims, @UploadedFile() file?: Express.Multer.File): Promise<ResumeItem> {
    return this.service.upload(user.sub, file);
  }

  @Get()
  list(@CurrentUser() user: JwtClaims, @Query() query: PageQueryDto): Promise<Paginated<ResumeItem>> {
    return this.service.list(user.sub, query.page, query.page_size);
  }

  @Delete(':id')
  @HttpCode(204)
  remove(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    return this.service.remove(user.sub, id);
  }
}

/** api-contract §7.1 — HR ดูเรซูเม่ของใบสมัครที่ส่งมาบริษัทตน (ต้องมี Consent) */
@Controller('hr/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('COMPANY_HR')
export class HrResumesController {
  constructor(private readonly service: ResumesService) {}

  @Get(':id/resume')
  get(
    @CurrentUser() user: JwtClaims,
    @Param('id', ParseUUIDPipe) id: string,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ResumeUrlResponse> {
    return this.service.forHr(user, id, cid);
  }
}

/** api-contract §7.1 — อาจารย์ดูเรซูเม่ของนักศึกษาในความดูแล */
@Controller('advisor/applications')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('ADVISOR')
export class AdvisorResumesController {
  constructor(private readonly service: ResumesService) {}

  @Get(':id/resume')
  get(@CurrentUser() user: JwtClaims, @Param('id', ParseUUIDPipe) id: string): Promise<ResumeUrlResponse> {
    return this.service.forAdvisor(user, id);
  }
}
