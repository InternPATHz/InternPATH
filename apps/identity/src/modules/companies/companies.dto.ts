import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength } from 'class-validator';
import type { CompanyDocType } from '@internpath/contracts';

export class UpdateCompanyDto {
  @IsOptional() @IsString() @MinLength(2) @MaxLength(200) name?: string;
  @IsOptional() @IsUrl({ require_tld: true }) website?: string;
  @IsOptional() @IsString() @MinLength(8) @MaxLength(30) phone?: string;
}

export class UploadDocumentDto {
  @IsIn(['REGISTRATION_CERT', 'VAT_CERT', 'AUTHORIZATION_LETTER', 'OTHER']) doc_type!: CompanyDocType;
}

export class CompanyQueryDto {
  @IsOptional() @IsIn(['PENDING', 'NEED_MORE_INFO', 'VERIFIED', 'REJECTED', 'SUSPENDED']) status?: 'PENDING' | 'NEED_MORE_INFO' | 'VERIFIED' | 'REJECTED' | 'SUSPENDED';
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}

export class CompanyActionDto {
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}
