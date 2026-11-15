import { Transform } from 'class-transformer';
import { IsString, MaxLength, MinLength } from 'class-validator';
import { NoNul } from '../common/no-nul';

export class AppealDto {
  @Transform(({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @NoNul()
  @MinLength(20)
  @MaxLength(2000)
  statement!: string;
}
