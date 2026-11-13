import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQuery } from '../common/pagination';

const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export const QUEUE_TYPES = ['JOB_REVIEW', 'JOB_APPEAL', 'COMPANY_ACCOUNT', 'JOB_REPORT', 'REVIEW_HELD', 'REVIEW_REPORT'] as const;

export class QueueQuery extends PageQuery {
  @IsOptional()
  @IsIn(QUEUE_TYPES)
  type?: (typeof QUEUE_TYPES)[number];

  @IsOptional()
  @IsIn(['NORMAL', 'FAST_TRACK'])
  priority?: 'NORMAL' | 'FAST_TRACK';

  @IsOptional()
  @IsIn(['LOW', 'MEDIUM', 'HIGH'])
  risk_level?: 'LOW' | 'MEDIUM' | 'HIGH';

  @IsOptional()
  @IsIn(['OPEN', 'IN_REVIEW', 'RESOLVED'])
  status?: 'OPEN' | 'IN_REVIEW' | 'RESOLVED';

  /** true = เฉพาะรายการที่เลยกำหนด (ยังไม่ RESOLVED และ due_at ผ่านไปแล้ว) */
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  overdue?: boolean;
}

export class RejectDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}
