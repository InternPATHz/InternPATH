import type { PageQuery, SearchJobsQuery } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
  NotContains,
} from 'class-validator';
import { JobCategory, WorkMode } from '../../../generated/client';

function parseInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

export class SearchJobsQueryDto implements SearchJobsQuery, PageQuery {
  @IsOptional()
  @IsString()
  @NotContains('\0')
  q?: string;

  @IsOptional()
  @IsEnum(JobCategory)
  category?: SearchJobsQuery['category'];

  @IsOptional()
  @IsEnum(WorkMode)
  work_mode?: SearchJobsQuery['work_mode'];

  @IsOptional()
  @IsString()
  @NotContains('\0')
  major?: string;

  @Transform(({ value }: { value: unknown }) => {
    if (value === 'true') return true;
    if (value === 'false') return false;
    return value;
  })
  @IsOptional()
  @IsBoolean()
  allowance?: boolean;

  @IsOptional()
  @IsUUID('4')
  company_id?: string;

  @IsOptional()
  @IsIn(['newest', 'deadline'])
  sort?: SearchJobsQuery['sort'];

  @Transform(parseInteger)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page?: number;

  @Transform(parseInteger)
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number;
}
