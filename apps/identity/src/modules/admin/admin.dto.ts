import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsEnum, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Matches, Max, MaxLength, Min } from 'class-validator';
import type { UpdateUniversityRequest } from '@internpath/contracts';
import { Role, UserStatus } from '../../../generated/client';

export class SetPartnerDto {
  @IsBoolean() enabled!: boolean;
}

export class SetEntitlementsDto {
  @IsBoolean() featured_enabled!: boolean;
  @IsBoolean() fast_track_enabled!: boolean;
}

export class UpdateUniversityDto implements UpdateUniversityRequest {
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString() @IsNotEmpty() @MaxLength(200) name?: string;
  @IsOptional() @Transform(({ value }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString() @Matches(/^[A-Z0-9]{2,10}$/, { message: 'ตัวย่อมหาวิทยาลัยต้องเป็น A-Z หรือ 0-9 ยาว 2–10 ตัว' }) abbreviation?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

export class UserActionDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class AdminUsersQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @IsEnum(Role) role?: Role;
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @IsUUID() university_id?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(50) target_type?: string;
  @IsOptional() @IsUUID() target_id?: string;
  /** รหัสที่คนอ่านได้แทน UUID: รหัสนักศึกษา/รหัสอาจารย์/อีเมล/เลขทะเบียนนิติบุคคล (ตรงทุกตัวอักษร) */
  @IsOptional() @IsString() @MaxLength(320) target_code?: string;
  @IsOptional() @IsUUID() admin_id?: string;
}
