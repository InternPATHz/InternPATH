import { IsEmail, IsNotEmpty, IsString, IsUUID, MinLength } from 'class-validator';

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
