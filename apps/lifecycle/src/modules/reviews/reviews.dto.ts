import type { CreateReviewRequest, ReplyReviewRequest } from '@internpath/contracts';
import { Transform } from 'class-transformer';
import { IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);
/** สตริงว่างหลัง trim ⇒ ถือว่าไม่ได้ส่ง (title ไม่บังคับ) */
const trimToUndefined = ({ value }: { value: unknown }) => {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  return t === '' ? undefined : t;
};

/**
 * ขอบเขตความยาวของรีวิว — เอกสารไม่กำหนด (ตัดสินเอง รอ PM ยืนยัน)
 * เนื้อหา ≤ 5000 เท่าข้อความยาวของ 1.4, หัวข้อ ≤ 200, คำตอบของบริษัท ≤ 2000
 */
export const REVIEW_LIMITS = Object.freeze({ TITLE_MAX: 200, BODY_MAX: 5000, REPLY_MAX: 2000 });

/** POST /applications/{id}/review */
export class CreateReviewDto implements CreateReviewRequest {
  @IsInt()
  @IsIn([1, 2, 3, 4, 5])
  rating!: 1 | 2 | 3 | 4 | 5;

  @IsOptional()
  @Transform(trimToUndefined)
  @IsString()
  @MaxLength(REVIEW_LIMITS.TITLE_MAX)
  title?: string;

  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(REVIEW_LIMITS.BODY_MAX)
  body!: string;

  @IsBoolean()
  anonymous!: boolean;
}

/** POST /hr/reviews/{id}/reply */
export class ReplyReviewDto implements ReplyReviewRequest {
  @Transform(trim)
  @IsString()
  @IsNotEmpty()
  @MaxLength(REVIEW_LIMITS.REPLY_MAX)
  body!: string;
}
