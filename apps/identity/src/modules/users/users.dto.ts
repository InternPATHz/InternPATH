import { IsNotEmpty, IsString, ValidateIf } from 'class-validator';
import type { UpdateMeRequest } from '@internpath/contracts';

export class UpdateMeDto implements UpdateMeRequest {
  @ValidateIf((_body, value) => value !== undefined) @IsString() @IsNotEmpty() full_name?: string;
  @ValidateIf((_body, value) => value !== undefined) @IsString() phone?: string;
}
