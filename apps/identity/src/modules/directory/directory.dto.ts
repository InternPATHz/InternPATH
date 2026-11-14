import { Transform } from 'class-transformer';
import { IsBoolean, IsString, MaxLength, ValidateIf } from 'class-validator';
import type { DirectoryCompaniesQuery } from '@internpath/contracts';

export class DirectoryQueryDto implements DirectoryCompaniesQuery {
  @ValidateIf((_body, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  q?: string;

  @ValidateIf((_body, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  category?: string;

  @Transform(({ value }: { value: unknown }) => value === 'true' ? true : value === 'false' ? false : value)
  @ValidateIf((_body, value) => value !== undefined)
  @IsBoolean()
  partner?: boolean;
}
