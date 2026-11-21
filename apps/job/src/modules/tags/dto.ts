import { Transform, Type } from 'class-transformer';
import { IsBoolean, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min, NotContains } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
const toBool = ({ value }: { value: unknown }) => (value === 'true' ? true : value === 'false' ? false : value);

export class TagListQuery {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @NotContains('\0')
  @MaxLength(50)
  q?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page: number = 1;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  page_size: number = 20;
}

export class AdminTagListQuery extends TagListQuery {
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  active?: boolean;
}

export class CreateTagDto {
  @Transform(trim)
  @IsString()
  @NotContains('\0')
  @IsNotEmpty()
  @MaxLength(50)
  name!: string;
}

export class UpdateTagDto {
  @IsOptional()
  @Transform(trim)
  @IsString()
  @NotContains('\0')
  @IsNotEmpty()
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsBoolean()
  active?: boolean;
}
