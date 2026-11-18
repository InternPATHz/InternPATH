import type { ResolveProblemReportRequest } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';
import { ProblemFollowUpAction as PrismaProblemFollowUpAction } from '../../../generated/client';
import { APPLICATION_LIMITS } from '../applications/applications.dto';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

type FollowUpAction = NonNullable<ResolveProblemReportRequest['follow_up_action']>;
/** ค่าที่รับได้ อ่านจาก enum ของ Prisma schema (ไม่ประกาศรายการซ้ำ) */
export const FOLLOW_UP_ACTIONS = Object.values(PrismaProblemFollowUpAction) as FollowUpAction[];

/** `resolve` — `note` บังคับ (ว่าง ⇒ `400 VALIDATION_FAILED`), `follow_up_action` ไม่บังคับ */
export class ResolveProblemReportDto implements ResolveProblemReportRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(APPLICATION_LIMITS.PROBLEM_DETAIL_MAX)
  note!: string;

  @IsOptional()
  @IsIn(FOLLOW_UP_ACTIONS)
  follow_up_action?: FollowUpAction;
}
