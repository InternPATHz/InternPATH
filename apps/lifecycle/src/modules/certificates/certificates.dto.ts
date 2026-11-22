import type { AdminCertificatesQuery, ReasonRequest } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { APPLICATION_LIMITS } from '../applications/applications.dto';
import { PageQueryDto } from '../resumes/resumes.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

/**
 * `{reason}` ของการเพิกถอน — บังคับ แต่ตรวจใน service ⇒ `400 REASON_REQUIRED`
 * (แบบเดียวกับ action อื่นที่บังคับเหตุผล ไม่ใช่ `VALIDATION_FAILED`) • ≤ 2000 ตัวอักษรเหมือน 1.4
 */
export class RevokeCertificateDto implements Partial<ReasonRequest> {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(APPLICATION_LIMITS.REASON_MAX)
  reason?: string;
}

/**
 * `GET /admin/lifecycle/certificates?code=` — `code` บังคับ (ไม่ส่ง/ว่าง ⇒ `400 VALIDATION_FAILED`)
 * ตัดช่องว่าง + ตัวพิมพ์ใหญ่ที่นี่ ⇒ service เทียบตรงตัวกับ `certificate_code` (เก็บเป็นตัวพิมพ์ใหญ่เสมอ)
 * เพดาน 100 ตัวกันคำขอยาวผิดปกติ (รหัสจริง 16 ตัว — รูปแบบผิดแต่ไม่เกินเพดาน ⇒ ผลว่าง ไม่ใช่ 400)
 */
export class AdminCertificatesQueryDto extends PageQueryDto implements AdminCertificatesQuery {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim().toUpperCase() : value))
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  code!: string;
}
