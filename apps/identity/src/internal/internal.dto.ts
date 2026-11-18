import { ArrayMaxSize, ArrayMinSize, IsArray, IsUUID } from 'class-validator';
import type { ConsentCheckBatchRequest, ConsentCheckRequest } from '@internpath/contracts';

export class ConsentCheckDto implements ConsentCheckRequest {
  @IsUUID() student_user_id!: string;
  @IsUUID() company_id!: string;
}

export class ConsentCheckBatchDto implements ConsentCheckBatchRequest {
  @IsUUID() company_id!: string;
  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100) @IsUUID('all', { each: true }) student_user_ids!: string[];
}
