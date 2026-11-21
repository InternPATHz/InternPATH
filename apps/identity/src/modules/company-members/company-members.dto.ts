import { Type } from 'class-transformer';
import { ArrayMaxSize, ArrayMinSize, ArrayUnique, IsArray, IsEmail, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';
import type { InviteMemberRequest, JobCategory, UpdateMemberCategoriesRequest } from '@internpath/contracts';

export const JOB_CATEGORIES: JobCategory[] = ['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES'];

/** api-contract §1 standard pagination for GET /companies/me/members */
export class MembersQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class InviteMemberDto implements InviteMemberRequest {
  @IsEmail() email!: string;
  /** สายงานของสมาชิกใหม่ 1–3 ค่า ไม่ซ้ำ (README 5.6) */
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsIn(JOB_CATEGORIES, { each: true }) categories!: JobCategory[];
}

export class UpdateMemberCategoriesDto implements UpdateMemberCategoriesRequest {
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(3) @ArrayUnique() @IsIn(JOB_CATEGORIES, { each: true }) categories!: JobCategory[];
}

export class AcceptInvitationDto {
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @MinLength(12) password!: string;
  @IsString() @IsNotEmpty() full_name!: string;
}

export class TransferOwnerDto {
  @IsUUID() to_user_id!: string;
}

export class AppointOwnerDto {
  @IsUUID() user_id!: string;
}
