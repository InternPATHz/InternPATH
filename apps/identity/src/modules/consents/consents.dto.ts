import { Equals, IsUUID, ValidateIf } from 'class-validator';
import type { RecordConsentRequest } from '@internpath/contracts';

export class RecordConsentDto implements RecordConsentRequest {
  @Equals('RESUME_SHARE') type!: 'RESUME_SHARE';
  @ValidateIf((_body, value) => value !== undefined) @IsUUID() application_id?: string;
  @IsUUID() target_company_id!: string;
}
