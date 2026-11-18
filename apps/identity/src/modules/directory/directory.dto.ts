import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsOptional, IsString, Matches, Max, MaxLength, Min, ValidateIf } from 'class-validator';
import type { DirectoryCompaniesQuery, PageQuery } from '@internpath/contracts';

/** สูงสุดของ `ids` (api-contract §4.4) */
export const DIRECTORY_IDS_MAX = 50;
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const IDS_PATTERN = new RegExp(`^${UUID}(?:,${UUID}){0,${DIRECTORY_IDS_MAX - 1}}$`, 'i');

export class DirectoryQueryDto implements DirectoryCompaniesQuery, PageQuery {
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

  /** UUID คั่นด้วย `,` สูงสุด 50 ตัว — เกินหรือรูปแบบผิด ⇒ 400 VALIDATION_FAILED */
  @ValidateIf((_body, value) => value !== undefined)
  @IsString()
  @Matches(IDS_PATTERN, { message: `ids must be 1-${DIRECTORY_IDS_MAX} comma-separated UUIDs` })
  ids?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) page = 1;
  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size = 20;
}
