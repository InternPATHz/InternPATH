import { Transform, Type } from 'class-transformer';
import { IsEmail, IsEnum, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, MaxLength, Min } from 'class-validator';
import type { AdminMoveStudentAdvisorRequest, CreateStudentRequest, UpdateStudentRequest } from '@internpath/contracts';
import { UserStatus } from '../../../generated/client';

export class AdvisorIdDto implements AdminMoveStudentAdvisorRequest {
  @IsUUID() advisor_id!: string;
}

/** GET /advisor-links/students?q=&year_level=&activation= */
export class AdvisorStudentsQueryDto {
  @IsOptional() @IsString() @MaxLength(100) q?: string;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(10) year_level?: number;
  @IsOptional() @IsIn(['PENDING', 'ACTIVE']) activation?: 'PENDING' | 'ACTIVE';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

export class CreateStudentDto implements CreateStudentRequest {
  @IsEmail() email!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) full_name!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(50) student_code!: string;
  @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) major!: string;
  @IsInt() @Min(1) @Max(10) year_level!: number;
}

export class UpdateStudentDto implements UpdateStudentRequest {
  @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) full_name?: string;
  @IsOptional() @Transform(trim) @IsString() @IsNotEmpty() @MaxLength(200) major?: string;
  @IsOptional() @IsInt() @Min(1) @Max(10) year_level?: number;
}

export class AdminAdvisorQueryDto {
  @IsOptional() @IsEnum(UserStatus) status?: UserStatus;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class AdvisorActionDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
