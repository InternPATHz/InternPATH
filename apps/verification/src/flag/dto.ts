import { Transform } from 'class-transformer';
import { IsBoolean, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { PageQuery } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

/** ตั้ง/เคลียร์ธง — `reason` บังคับทั้งสองทิศ */
export class SetFlagDto {
  @IsBoolean()
  active!: boolean;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(1000)
  reason!: string;
}

/** `company-clear-flag` ในคิว — เหตุผลไม่บังคับ */
export class ClearFlagDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class FlagListQuery extends PageQuery {
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  active?: boolean;

  /** ค้นชื่อบริษัท (ไม่สนตัวพิมพ์) */
  @IsOptional()
  @IsString()
  q?: string;
}
