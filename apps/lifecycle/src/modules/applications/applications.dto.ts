import type {
  ApplicationStatus,
  CreateApplicationRequest,
  CreateProblemReportRequest,
  DisputeFailRequest,
  ProblemReportCategory,
} from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import {
  ApplicationStatus as PrismaApplicationStatus,
  ProblemReportCategory as PrismaProblemReportCategory,
} from '../../../generated/client';
import { PageQueryDto } from '../resumes/resumes.dto';

/**
 * ขอบเขตความยาวของข้อความในคำขอ — เอกสารยังไม่กำหนด ตั้งเองใน 1.4 เพื่อกันข้อมูลใหญ่ผิดปกติ (ให้ PM ยืนยัน)
 */
export const APPLICATION_LIMITS = {
  COVER_LETTER_MAX: 5000,
  REASON_MAX: 2000,
  STATEMENT_MAX: 5000,
  PROBLEM_DETAIL_MAX: 5000,
} as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** ค่าที่รับได้ อ่านจาก enum ของ Prisma schema ของ Lifecycle (แหล่งเดียวกับคอลัมน์ — ไม่ประกาศรายการซ้ำ) */
export const APPLICATION_STATUSES = Object.values(PrismaApplicationStatus) as ApplicationStatus[];
export const PROBLEM_REPORT_CATEGORIES = Object.values(PrismaProblemReportCategory) as ProblemReportCategory[];

/**
 * POST /applications — `consent` รับเป็น boolean แล้วให้ service ตรวจว่าเป็น `true`
 * (ไม่ติ๊ก ⇒ `403 CONSENT_REQUIRED` ตาม UAT-29 ข้อ 4 แทน `400 VALIDATION_FAILED`)
 */
export class CreateApplicationDto implements Omit<CreateApplicationRequest, 'consent'> {
  @IsUUID()
  job_id!: string;

  @IsUUID()
  resume_id!: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.COVER_LETTER_MAX)
  cover_letter?: string;

  @IsBoolean()
  consent!: boolean;
}

/** GET /me/applications — `?status=` + Pagination มาตรฐาน */
export class MyApplicationsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(APPLICATION_STATUSES)
  status?: ApplicationStatus;
}

/**
 * เหตุผลของ action นักศึกษา — `withdraw` ไม่บังคับ; `request-termination` บังคับแต่ตรวจใน Guard `reasonRequired`
 * ของ State Machine เพื่อให้ได้ `400 REASON_REQUIRED` แบบเดียวกับทุก action (ไม่ใช่ `VALIDATION_FAILED`)
 */
export class ReasonDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;
}

export class DisputeFailDto implements DisputeFailRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(APPLICATION_LIMITS.STATEMENT_MAX)
  statement!: string;
}

export class CreateProblemReportDto implements CreateProblemReportRequest {
  @IsIn(PROBLEM_REPORT_CATEGORIES)
  category!: ProblemReportCategory;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(APPLICATION_LIMITS.PROBLEM_DETAIL_MAX)
  detail!: string;
}
