import { Type } from 'class-transformer';
import { IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUUID, Max, Min, MinLength } from 'class-validator';

/** api-contract §1 standard pagination for GET /companies/me/members */
export class MembersQueryDto {
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class InviteMemberDto {
  @IsEmail() email!: string;
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
