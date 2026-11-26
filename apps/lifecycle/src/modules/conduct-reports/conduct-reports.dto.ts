import type {
  AcknowledgeConductReportRequest,
  ConductReportCategory,
  ConductReportStatus,
  CreateConductReportRequest,
} from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsIn, IsOptional, IsString, Length, MaxLength } from 'class-validator';
import {
  ConductReportCategory as PrismaConductReportCategory,
  ConductReportStatus as PrismaConductReportStatus,
} from '../../../generated/client';
import { PageQueryDto } from '../resumes/resumes.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/** ค่าที่รับได้ อ่านจาก enum ของ Prisma schema (ไม่ประกาศรายการซ้ำ) */
export const CONDUCT_REPORT_CATEGORIES = Object.values(PrismaConductReportCategory) as ConductReportCategory[];
export const CONDUCT_REPORT_STATUSES = Object.values(PrismaConductReportStatus) as ConductReportStatus[];

/** รายละเอียด 10–2000 ตัวอักษร (ตรงกับ CHECK ใน migration) — สั้นเกินไปอาจารย์อ่านแล้วไม่รู้เรื่อง */
export const CONDUCT_DETAIL_MIN = 10;
export const CONDUCT_DETAIL_MAX = 2000;

export class CreateConductReportDto implements CreateConductReportRequest {
  @IsIn(CONDUCT_REPORT_CATEGORIES)
  category!: ConductReportCategory;

  @Transform(trim)
  @IsString()
  @Length(CONDUCT_DETAIL_MIN, CONDUCT_DETAIL_MAX)
  detail!: string;
}

export class AcknowledgeConductReportDto implements AcknowledgeConductReportRequest {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(CONDUCT_DETAIL_MAX)
  note?: string;
}

/** GET /advisor/conduct-reports?status= */
export class AdvisorConductReportsQueryDto extends PageQueryDto {
  @IsOptional()
  @IsIn(CONDUCT_REPORT_STATUSES)
  status?: ConductReportStatus;
}
