import { Body, Controller, Get, Headers, Put, UseGuards } from '@nestjs/common';
import { CurrentUser, JwtAuthGuard, type JwtClaims, Roles, RolesGuard } from '@internpath/common';
import type { StudentProfile } from '@internpath/contracts';
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
}
