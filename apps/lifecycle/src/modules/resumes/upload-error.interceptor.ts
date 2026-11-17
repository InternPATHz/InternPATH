import {
  BadRequestException,
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
  PayloadTooLargeException,
} from '@nestjs/common';
import { AppException } from '@internpath/common';
import { Observable, catchError, throwError } from 'rxjs';
import { RESUME_FILE_FIELD } from './resume-file';

/**
 * แปลง error ของ multer ให้เป็น error code ตาม api-contract §2
 * - ไฟล์เกินขนาด (multer → 413 PayloadTooLarge) ⇒ `400 FILE_TOO_LARGE`
 * - ฟิลด์ไฟล์ผิดชื่อ/หลายไฟล์ (multer → 400 BadRequest) ⇒ `400 VALIDATION_FAILED`
 * ต้องวางก่อน `FileInterceptor` ใน `@UseInterceptors(...)` เพื่อครอบมัน
 */
@Injectable()
export class UploadErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(catchError((error: unknown) => throwError(() => mapUploadError(error))));
  }
}

export function mapUploadError(error: unknown): unknown {
  if (error instanceof AppException) return error;
  if (error instanceof PayloadTooLargeException) {
    return new AppException('FILE_TOO_LARGE', 'ไฟล์เรซูเม่ต้องไม่เกิน 5 MB', 400, [
      { field: RESUME_FILE_FIELD, issue: 'MAX_5_MB' },
    ]);
  }
  if (error instanceof BadRequestException) {
    return new AppException('VALIDATION_FAILED', 'ข้อมูลไฟล์ไม่ถูกต้อง', 400, [
      { field: RESUME_FILE_FIELD, issue: 'INVALID_UPLOAD' },
    ]);
  }
  return error;
}
