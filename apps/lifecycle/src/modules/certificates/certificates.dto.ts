import type { ReasonRequest } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { APPLICATION_LIMITS } from '../applications/applications.dto';

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
