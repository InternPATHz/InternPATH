import { HttpException } from '@nestjs/common';

export interface ErrorDetail {
  field?: string;
  issue: string;
}

/**
 * Error ของ Business Logic — ตรงกับรูปแบบใน docs/api-contract.md §2
 * ตัวอย่าง: throw new AppException('QUOTA_FULL', 'โควตาตำแหน่งเต็มแล้ว', 409)
 */
export class AppException extends HttpException {
  constructor(
    public readonly code: string,
    message: string,
    status = 400,
    public readonly details?: ErrorDetail[],
  ) {
    super({ code, message, details }, status);
  }
}
