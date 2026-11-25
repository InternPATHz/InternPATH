import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, MinLength, ValidateNested, Equals } from 'class-validator';
import type { AcceptStudentInvitationRequest, RegisterCompanyRequest, LoginRequest, RefreshRequest, VerifyEmailRequest, ForgotPasswordRequest, ResetPasswordRequest } from '@internpath/contracts';

export class AcceptStudentInvitationDto implements AcceptStudentInvitationRequest {
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @MinLength(12) password!: string;
  @IsBoolean() @Equals(true) accept_privacy!: true;
}

export class RegisterAdvisorDto {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
  @IsString() @IsNotEmpty() full_name!: string;
  @IsString() @IsNotEmpty() department!: string;
  @IsBoolean() @Equals(true) accept_privacy!: true;
}

class CompanyInput {
  @IsString() @IsNotEmpty() name!: string;
  @IsString() @Matches(/^[0-9]{13}$/, { message: 'เลขทะเบียนนิติบุคคลต้องเป็นตัวเลข 13 หลัก' }) registration_no!: string;
  @IsOptional() @IsUrl({ require_tld: true }) website?: string;
  @IsOptional() @IsString() phone?: string;
}

class CompanyUserInput {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
  @IsString() @IsNotEmpty() full_name!: string;
}

export class RegisterCompanyDto implements RegisterCompanyRequest {
  @ValidateNested() @Type(() => CompanyInput) company!: CompanyInput;
  @ValidateNested() @Type(() => CompanyUserInput) user!: CompanyUserInput;
  @IsBoolean() @Equals(true) accept_privacy!: true;
}

export class TokenDto implements VerifyEmailRequest {
  @IsString() @IsNotEmpty() token!: string;
}

export class EmailDto implements ForgotPasswordRequest {
  @IsEmail() email!: string;
}

export class LoginDto implements LoginRequest {
  @IsEmail() email!: string;
  @IsString() password!: string;
  @IsOptional() @IsString() @IsNotEmpty() unlock_token?: string;
}

export class RefreshDto implements RefreshRequest {
  @IsString() @IsNotEmpty() refresh_token!: string;
}

export class ResetPasswordDto implements ResetPasswordRequest {
  @IsString() @IsNotEmpty() token!: string;
  @IsString() @MinLength(12) new_password!: string;
}
