import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PageQuery } from '../common/pagination';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class TermQuery extends PageQuery {
  @IsOptional()
  @IsIn(['HARD', 'SOFT'])
  severity?: 'HARD' | 'SOFT';

  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsString()
  q?: string;
}

export class CreateTermDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  term!: string;

  @IsIn(['HARD', 'SOFT'])
  severity!: 'HARD' | 'SOFT';

  /** SOFT เท่านั้น (จำนวนเต็ม ≥ 0); HARD ห้ามมี */
  @IsOptional()
  @IsInt()
  @Min(0)
  weight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;
}

export class UpdateTermDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(0)
  weight?: number;

  @IsOptional()
  @IsString()
  @MaxLength(50)
  category?: string;
}

export class TestTextDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100_000)
  text!: string;
}

export class RuleUpdateDto {
  @IsString()
  @IsNotEmpty()
  code!: string;

  @IsOptional()
  @IsInt()
  @Min(0)
  weight?: number;

  /** ส่งเฉพาะคีย์ที่ต้องการเปลี่ยน (รวมเข้ากับค่าเดิม) */
  @IsOptional()
  @IsObject()
  params?: Record<string, number>;

  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}

export class CueUpdateDto {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(50)
  cue!: string;

  @IsBoolean()
  enabled!: boolean;
}

export class UpdateRiskRulesDto {
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => RuleUpdateDto)
  rules?: RuleUpdateDto[];

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CueUpdateDto)
  negation_cues?: CueUpdateDto[];
}
