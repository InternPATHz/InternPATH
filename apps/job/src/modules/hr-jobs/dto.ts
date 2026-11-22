import type { UpdateJobRequest } from '@internpath/contracts';
import { Type } from 'class-transformer';
import {
  Allow,
  ArrayNotEmpty,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsString,
  Matches,
  Max,
  Min,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { JobCategory, JobStatus, WorkMode } from '../../../generated/client';

const IfSupplied = () => ValidateIf((_object, value) => value !== undefined);
const datePattern = /^\d{4}-\d{2}-\d{2}$/;

class AllowanceDto {
  @IsIn(['AMOUNT', 'NONE']) type!: 'AMOUNT' | 'NONE';
  @IfSupplied() @IsInt() @Min(1) @Max(2147483647) amount_thb?: number;
  @IfSupplied() @IsString() text?: string;
}

class PeriodDto {
  @Matches(datePattern) @IsDateString({ strict: true }) start!: string;
  @Matches(datePattern) @IsDateString({ strict: true }) end!: string;
}

export class WriteJobDto implements Omit<UpdateJobRequest, 'tag_ids'> {
  @IfSupplied() @IsIn(Object.values(JobCategory)) category?: JobCategory;
  @IfSupplied() @IsString() @Matches(/\S/) job_title?: string;
  @IfSupplied() @IsString() @Matches(/\S/) description?: string;
  @IfSupplied() @IsString() @Matches(/\S/) responsibilities?: string;
  @IfSupplied() @IsString() @Matches(/\S/) qualifications?: string;
  @IfSupplied() @IsObject() @ValidateNested() @Type(() => AllowanceDto) allowance?: AllowanceDto;
  @IfSupplied() @IsString() @Matches(/\S/) location?: string;
  @IfSupplied() @IsString() contact_notes?: string;
  @IfSupplied() @IsIn(Object.values(WorkMode)) work_mode?: WorkMode;
  @IfSupplied() @IsInt() @Min(1) @Max(168) hours_per_week?: number;
  @IfSupplied() @IsObject() @ValidateNested() @Type(() => PeriodDto) period?: PeriodDto;
  @IfSupplied()
  @IsArray()
  @ArrayNotEmpty()
  @IsNotEmpty({ each: true })
  @IsString({ each: true })
  @Matches(/\S/, { each: true })
  target_majors?: string[];
  @Allow() tag_ids?: unknown; // Validate in the service to return the §5.4 issue codes.
  @IfSupplied() @IsInt() @Min(1) @Max(2147483647) quota?: number;
  @IfSupplied() @Matches(datePattern) @IsDateString({ strict: true }) application_deadline?: string;
}

export class HrJobsQueryDto {
  @IfSupplied() @IsIn(Object.values(JobStatus)) status?: JobStatus;
  @IfSupplied() @IsIn(Object.values(JobCategory)) category?: JobCategory;
  @IfSupplied() @Type(() => Number) @IsInt() @Min(1) @Max(2147483647) page?: number;
  @IfSupplied() @Type(() => Number) @IsInt() @Min(1) @Max(100) page_size?: number;
}

export class FeaturedDto {
  @IsBoolean() enabled!: boolean;
}
