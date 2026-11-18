import type {
  AcademicResult,
  AcademicResultRequest,
  AdvisorApplicationsQuery,
  ApplicationStatus,
  ProblemReportStatus,
} from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { AcademicResult as PrismaAcademicResult, ProblemReportStatus as PrismaProblemReportStatus } from '../../../generated/client';
import { APPLICATION_LIMITS, APPLICATION_STATUSES } from '../applications/applications.dto';
import { PageQueryDto } from '../resumes/resumes.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** ค่าที่รับได้ อ่านจาก enum ของ Prisma schema (ไม่ประกาศรายการซ้ำ) */
export const ACADEMIC_RESULTS = Object.values(PrismaAcademicResult) as AcademicResult[];
export const PROBLEM_REPORT_STATUSES = Object.values(PrismaProblemReportStatus) as ProblemReportStatus[];

/** GET /advisor/applications — `?status=` (เช่น `ADVISOR_PENDING`) + Pagination มาตรฐาน */
export class AdvisorApplicationsQueryDto extends PageQueryDto implements AdvisorApplicationsQuery {
  @IsOptional()
  @IsIn(APPLICATION_STATUSES)
  status?: ApplicationStatus;
}

/**
 * เหตุผลของ `reject` / `terminate` — บังคับ แต่ตรวจใน Guard `reasonRequired` ของ State Machine
 * เพื่อให้ได้ `400 REASON_REQUIRED` แบบเดียวกับทุก action (ไม่ใช่ `VALIDATION_FAILED`)
 */
export class AdvisorReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;
}

/** `request-reevaluation` / `uphold-fail` — contract ไม่กำหนด body; รับหมายเหตุไม่บังคับเก็บใน `fail_disputes.decision_note` */
export class DisputeDecisionDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  note?: string;
}

/** ค่าที่บันทึกได้ตามสถานะตรวจใน Guard `academicResultAllowed` (ห้าม FAIL ของบริษัท → PASS) */
export class AcademicResultDto implements AcademicResultRequest {
  @IsIn(ACADEMIC_RESULTS)
  academic_result!: AcademicResult;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.STATEMENT_MAX)
  note?: string;
}

/** GET /advisor/problem-reports — `?status=` + Pagination มาตรฐาน */
export class AdvisorProblemReportsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(PROBLEM_REPORT_STATUSES)
  status?: ProblemReportStatus;
}
