import type { ApplicationStatus, AuditQuery, ProblemReportStatus, ReapplyUnlockRequest } from '@internpath/contracts';
import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsDate, IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { PROBLEM_REPORT_STATUSES } from '../advisor/advisor.dto';
import { APPLICATION_LIMITS } from '../applications/applications.dto';
import { PageQueryDto } from '../resumes/resumes.dto';
import { NO_EVALUATION_SOURCE_STATUSES } from '../../state-machine/transition-table';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** query string `true`/`false` ⇒ boolean (ค่าอื่นคงไว้ให้ `@IsBoolean` ปฏิเสธ ⇒ 400) */
const toBoolean = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** GET /admin/lifecycle/no-evaluation-candidates — `?status=` จำกัดเฉพาะ 3 สถานะต้นทางของ `NO_EVALUATION` */
export class NoEvaluationCandidatesQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(NO_EVALUATION_SOURCE_STATUSES)
  status?: ApplicationStatus;
}

/**
 * เหตุผลของ action ของ Admin — `terminate`/`reapply-unlock` บังคับ (ตรวจใน service/Guard `reasonRequired`
 * เพื่อให้ได้ `400 REASON_REQUIRED` แบบเดียวกับทุก action ไม่ใช่ `VALIDATION_FAILED`)
 * `confirm-no-evaluation` ไม่บังคับ (บันทึกผลการติดตามบริษัทใน audit log)
 */
export class AdminReasonDto implements Partial<ReapplyUnlockRequest> {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;
}

/** GET /admin/lifecycle/problem-reports — `?status=`, `?overdue=true|false` + Pagination มาตรฐาน */
export class AdminProblemReportsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(PROBLEM_REPORT_STATUSES)
  status?: ProblemReportStatus;

  @IsOptional()
  @Transform(toBoolean)
  @IsBoolean()
  overdue?: boolean;
}

/**
 * GET /admin/lifecycle/audit-logs — ตัวกรองตาม `AuditQuery` ของ contracts (เหมือน `/admin/audit` ของ Verification)
 * + `target_id` สำหรับดูประวัติของเป้าหมายเดียว (เช่น ใบสมัคร/นักศึกษา)
 */
export class AuditLogsQueryDto extends PageQueryDto implements Omit<AuditQuery, 'from' | 'to'> {
  @IsOptional()
  @IsUUID()
  actor?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  action?: string;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  target_type?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  target_id?: string;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  from?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  to?: Date;
}
