import type {
  ApplicationStatus,
  HrAcceptRequest,
  HrApplicationsQuery,
  HrEvaluateRequest,
  HrRejectRequest,
  HrStartRequest,
  HrTerminateRequest,
  JobCategory,
} from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsDateString, IsIn, IsOptional, IsString, IsUUID, Matches, MaxLength } from 'class-validator';
import { APPLICATION_LIMITS, APPLICATION_STATUSES } from '../applications/applications.dto';
import { PageQueryDto } from '../resumes/resumes.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** วันที่ `YYYY-MM-DD` ที่มีอยู่จริงบนปฏิทิน (คอลัมน์ `@db.Date`) */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const DateOnly = (): PropertyDecorator => (target, key) => {
  Matches(DATE_ONLY, { message: `${String(key)} ต้องเป็นรูปแบบ YYYY-MM-DD` })(target, key);
  IsDateString({ strict: true })(target, key);
};

/** หมายเหตุประกอบผลประเมิน — เอกสารไม่กำหนด ใช้ขอบเขตเดียวกับข้อความยาวของ 1.4 */
export const EVALUATION_NOTE_MAX = APPLICATION_LIMITS.STATEMENT_MAX;

/** ค่าของ `?category=` (ตรงกับ enum `job_category`) */
export const JOB_CATEGORIES: readonly JobCategory[] = ['TECH_IT', 'BUSINESS_MARKETING', 'CORPORATE_SERVICES'];

/** GET /hr/applications — `?job_id=&status=&category=` + Pagination มาตรฐาน */
export class HrApplicationsQueryDto extends PageQueryDto implements HrApplicationsQuery {
  @IsOptional()
  @IsUUID()
  job_id?: string;

  @IsOptional()
  @IsIn(APPLICATION_STATUSES)
  status?: ApplicationStatus;

  @IsOptional()
  @IsIn(JOB_CATEGORIES)
  category?: JobCategory;
}

/** ช่วงฝึก ≥ 30 วันตรวจใน Guard `periodMin30Days` ⇒ `422 INVALID_PERIOD_MIN_30_DAYS` */
export class HrAcceptDto implements HrAcceptRequest {
  @DateOnly()
  start_date!: string;

  @DateOnly()
  end_date!: string;
}

/**
 * เหตุผลของ `reject` (ไม่บังคับ) / `rescind-offer` (บังคับ — ตรวจใน Guard `reasonRequired` ⇒ `400 REASON_REQUIRED`
 * แบบเดียวกับทุก action ไม่ใช่ `VALIDATION_FAILED`)
 */
export class HrReasonDto implements HrRejectRequest {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;
}

export class HrStartDto implements HrStartRequest {
  @DateOnly()
  actual_start_date!: string;

  @IsOptional()
  @DateOnly()
  start_date?: string;

  @IsOptional()
  @DateOnly()
  end_date?: string;
}

/** `reason` บังคับ (Guard) • `actual_end_date` ไม่ส่ง ⇒ วันนี้ตามเวลากรุงเทพ */
export class HrTerminateDto implements Partial<HrTerminateRequest> {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;

  @IsOptional()
  @DateOnly()
  actual_end_date?: string;
}

/** `reason` บังคับเมื่อ FAIL (Guard ⇒ `400 REASON_REQUIRED`) */
export class HrEvaluateDto implements HrEvaluateRequest {
  @IsIn(['PASS', 'FAIL'])
  result!: 'PASS' | 'FAIL';

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(EVALUATION_NOTE_MAX)
  note?: string;
}
