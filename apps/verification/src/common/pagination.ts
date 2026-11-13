import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/** รูปแบบรายการมาตรฐานของ API (docs/api-contract.md §1) */
export interface Page<T> {
  data: T[];
  meta: { page: number; page_size: number; total: number };
}

export class PageQuery {
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

export const skipOf = (q: PageQuery): number => (q.page - 1) * q.page_size;
