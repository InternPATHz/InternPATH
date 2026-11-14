import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { RequestAdvisorLinkRequest, AdminMoveStudentAdvisorRequest } from '@internpath/contracts';
import { UserStatus } from '../../../generated/client';

export class AdvisorIdDto implements RequestAdvisorLinkRequest, AdminMoveStudentAdvisorRequest {
  @IsUUID() advisor_id!: string;
}

export class AdvisorSearchDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class AdminAdvisorQueryDto {
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class AdvisorActionDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
