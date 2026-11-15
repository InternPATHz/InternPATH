import { IsUUID } from 'class-validator';
import type { ConsentCheckRequest } from '@internpath/contracts';

export class ConsentCheckDto implements ConsentCheckRequest {
  @IsUUID() student_user_id!: string;
  @IsUUID() company_id!: string;
}
