import { Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';

export class SetPartnerDto {
  @IsBoolean() enabled!: boolean;
}

export class SetEntitlementsDto {
  @IsBoolean() featured_enabled!: boolean;
  @IsBoolean() fast_track_enabled!: boolean;
}

export class UserActionDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

export class AuditQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
  @IsOptional() @IsString() @MaxLength(100) action?: string;
  @IsOptional() @IsString() @MaxLength(50) target_type?: string;
  @IsOptional() @IsUUID() target_id?: string;
  @IsOptional() @IsUUID() admin_id?: string;
}
