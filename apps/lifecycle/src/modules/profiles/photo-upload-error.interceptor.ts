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
import { PHOTO_FILE_FIELD } from './photo-file';

/**
 * แปลง error ของ multer ตอนอัปโหลดรูปโปรไฟล์ให้เป็น error code ตาม api-contract §2 (แบบเดียวกับเรซูเม่)
 * เกิน 2 MB ⇒ `400 FILE_TOO_LARGE` • ฟิลด์ผิด/หลายไฟล์ ⇒ `400 VALIDATION_FAILED` — วางก่อน `FileInterceptor`
 */
@Injectable()
export class PhotoUploadErrorInterceptor implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(
      catchError((error: unknown) => {
        if (error instanceof PayloadTooLargeException) {
          return throwError(
            () => new AppException('FILE_TOO_LARGE', 'รูปโปรไฟล์ต้องไม่เกิน 2 MB', 400, [{ field: PHOTO_FILE_FIELD, issue: 'MAX_2_MB' }]),
          );
        }
        if (error instanceof BadRequestException && !(error instanceof AppException)) {
          return throwError(
            () => new AppException('VALIDATION_FAILED', 'ข้อมูลไฟล์ไม่ถูกต้อง', 400, [{ field: PHOTO_FILE_FIELD, issue: 'INVALID_UPLOAD' }]),
          );
        }
        return throwError(() => error);
      }),
    );
  }
}
