import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown => (typeof value === 'string' ? value.trim() : value);

/** เหตุผลของผู้รายงานรีวิว 10–1000 ตัวอักษร (สไลซ์ 3 §3) — ห้าม log */
export class ReviewReportDto {
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(1000)
  reason!: string;
}

/** เหตุผลของ Admin ตอนเผยแพร่/ยืนยันให้คงอยู่ (ไม่บังคับ สูงสุด 500) */
export class PublishReviewDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(500)
  reason?: string;
}

/** เหตุผลของ Admin ตอนลบรีวิว (บังคับ 1–500 ตัวอักษร) */
export class RemoveReviewDto {
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  reason!: string;
}
