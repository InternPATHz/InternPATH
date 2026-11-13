import type { JobReportCategory, ReportJobRequest } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/** ค่าของ JobReportCategory (api-contract §11) — ชนิดจาก libs/contracts ตรวจให้ครบตอนคอมไพล์ */
export const JOB_REPORT_CATEGORIES = [
  'SCAM_OR_FEE',
  'MISLEADING_INFO',
  'INAPPROPRIATE_CONTENT',
  'DUPLICATE_OR_SPAM',
  'OTHER',
] as const satisfies readonly JobReportCategory[];

/** เหตุผลของ Admin ตอนยกคำร้อง/ยืนยันรายงาน (ไม่บังคับ) */
export class ReportResolutionDto {
  @IsOptional()
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

/** รายงานที่ถูกต้องต้องมีหมวดและรายละเอียด 20–1000 ตัวอักษร (README 5.1.3, R5-G01) */
export class ReportDto implements ReportJobRequest {
  @IsIn(JOB_REPORT_CATEGORIES)
  category!: JobReportCategory;

  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @MinLength(20)
  @MaxLength(1000)
  detail!: string;
}
