import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { DirectoryCompaniesQuery } from '@internpath/contracts';

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
export const DIRECTORY_IDS_MAX = 50;
/** 1–50 UUIDs separated by `,` (api-contract §4.4). Anything else is a validation error. */
const IDS_PATTERN = new RegExp(`^${UUID}(?:,${UUID}){0,${DIRECTORY_IDS_MAX - 1}}$`);

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

  @ValidateIf((_body, value) => value !== undefined)
  @IsString()
  @Matches(IDS_PATTERN, { message: `ids must be 1-${DIRECTORY_IDS_MAX} comma-separated UUIDs` })
  ids?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}
