import { Body, Controller, Delete, Get, Headers, HttpCode, Put, UploadedFile, UseGuards, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { ProfilePhotoResponse, StudentProfile } from '@internpath/contracts';
import { PHOTO_FILE_FIELD, PHOTO_MAX_BYTES } from './photo-file';
import { PhotoUploadErrorInterceptor } from './photo-upload-error.interceptor';
import { UpdateProfileDto } from './profiles.dto';
import { ProfilesService } from './profiles.service';

/** api-contract §7.1 — โปรไฟล์ของนักศึกษาที่ล็อกอินอยู่ (เจ้าของ = `sub` ใน Token เสมอ) */
@Controller('me/profile')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('STUDENT')
export class ProfilesController {
  constructor(private readonly service: ProfilesService) {}

  @Get()
  get(@CurrentUser() user: JwtClaims, @Headers('x-correlation-id') cid?: string): Promise<StudentProfile> {
    return this.service.get(user.sub, cid);
  }

  @Put()
  update(
    @CurrentUser() user: JwtClaims,
    @Body() body: UpdateProfileDto,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<StudentProfile> {
    return this.service.update(user.sub, body, cid);
  }

  /** multipart ฟิลด์ `file` (jpg/png/webp ≤ 2 MB) — multer เก็บในหน่วยความจำและตัดที่ 2 MB */
  @Put('photo')
  @UseInterceptors(
    PhotoUploadErrorInterceptor,
    FileInterceptor(PHOTO_FILE_FIELD, { limits: { fileSize: PHOTO_MAX_BYTES, files: 1 } }),
  )
  uploadPhoto(
    @CurrentUser() user: JwtClaims,
    @UploadedFile() file?: Express.Multer.File,
    @Headers('x-correlation-id') cid?: string,
  ): Promise<ProfilePhotoResponse> {
    return this.service.uploadPhoto(user.sub, file, cid);
  }

  @Delete('photo')
  @HttpCode(204)
  async deletePhoto(@CurrentUser() user: JwtClaims): Promise<void> {
    await this.service.deletePhoto(user.sub);
  }
}
