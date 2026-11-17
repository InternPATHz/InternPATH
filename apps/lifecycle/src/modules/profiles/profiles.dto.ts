import { Transform } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsOptional, IsString, IsUrl, Length, MaxLength } from 'class-validator';

/** ขอบเขตความยาวของฟิลด์โปรไฟล์ (ยังไม่มีในเอกสาร — ตั้งเองใน 1.3 เพื่อกันข้อมูลใหญ่ผิดปกติ) */
export const PROFILE_LIMITS = {
  HEADLINE_MAX: 200,
  BIO_MAX: 2000,
  SKILLS_MAX_ITEMS: 30,
  SKILL_MAX_LENGTH: 50,
  PORTFOLIO_URL_MAX: 500,
} as const;

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * PUT /me/profile — แทนที่ฟิลด์ที่นักศึกษาแก้เองได้ทั้งชุด (ไม่ส่ง = ล้างค่า)
 * `major` / `year_level` ห้ามส่งมา (สำเนาจาก Identity เท่านั้น — whitelist จะปฏิเสธ)
 */
export class UpdateProfileDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(PROFILE_LIMITS.HEADLINE_MAX)
  headline?: string;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(PROFILE_LIMITS.SKILLS_MAX_ITEMS)
  @Transform(({ value }) => (Array.isArray(value) ? value.map((v) => (typeof v === 'string' ? v.trim() : v)) : value))
  @IsString({ each: true })
  @Length(1, PROFILE_LIMITS.SKILL_MAX_LENGTH, { each: true })
  skills?: string[];

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(PROFILE_LIMITS.BIO_MAX)
  bio?: string;

  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(PROFILE_LIMITS.PORTFOLIO_URL_MAX)
  @IsUrl({ protocols: ['http', 'https'], require_protocol: true })
  portfolio_url?: string;
}
