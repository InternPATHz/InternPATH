import type { AdminJobsQuery } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  NotContains,
} from 'class-validator';
import { JobStatus } from '../../../generated/client';

function parseInteger({ value }: { value: unknown }): unknown {
  return typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
}

export class AdminJobsQueryDto implements AdminJobsQuery {
  @IsOptional()
  @IsEnum(JobStatus)
  status?: JobStatus;

  @IsOptional()
  @IsUUID('4')
  company_id?: string;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @NotContains('\0')
  @MaxLength(200)
  q?: string;

  @IsOptional()
  @Transform(parseInteger)
  @IsInt()
  @Min(1)
  @Max(Number.MAX_SAFE_INTEGER)
  page?: number;

  @IsOptional()
  @Transform(parseInteger)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size?: number;
}
