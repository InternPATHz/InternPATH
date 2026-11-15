import { Type } from 'class-transformer';
import { IsBoolean, IsEmail, IsInt, IsNotEmpty, IsOptional, IsString, IsUrl, Max, Min, MinLength, ValidateNested, Equals } from 'class-validator';
import type { RegisterStudentRequest, RegisterCompanyRequest, LoginRequest, RefreshRequest, VerifyEmailRequest, ForgotPasswordRequest, ResetPasswordRequest } from '@internpath/contracts';

export class RegisterStudentDto implements RegisterStudentRequest {
  @IsEmail() email!: string;
  @IsString() @MinLength(12) password!: string;
  @IsString() @IsNotEmpty() full_name!: string;
  @IsString() @IsNotEmpty() student_code!: string;
  @IsString() @IsNotEmpty() major!: string;
  @IsInt() @Min(1) @Max(10) year_level!: number;
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
  @IsString() @IsNotEmpty() registration_no!: string;
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
