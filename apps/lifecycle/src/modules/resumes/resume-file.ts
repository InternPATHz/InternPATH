import { detectFileType } from '../../common/file-type';
import { AppException } from '@internpath/common';

/** README §5.9 — เรซูเม่เป็น PDF ≤ 5 MB */
export const RESUME_MAX_BYTES = 5 * 1024 * 1024;
export const RESUME_MIME = 'application/pdf';
/** ชื่อฟิลด์ multipart ของไฟล์ */
export const RESUME_FILE_FIELD = 'file';

export interface UploadedResumeFile {
  buffer: Buffer;
  size?: number;
}

/**
 * ตรวจไฟล์เรซูเม่ฝั่ง Server: ต้องมีไฟล์, ขนาด ≤ 5 MB และ **MIME จริงจากเนื้อไฟล์** เป็น PDF
 * (ไม่เชื่อนามสกุลหรือ Content-Type ที่ client ส่งมา — UAT-42)
 * Error code ตาม api-contract §2: `VALIDATION_FAILED`, `FILE_TOO_LARGE`, `FILE_TYPE_NOT_ALLOWED` (400)
 */
export async function assertResumeFile(file: UploadedResumeFile | undefined): Promise<void> {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw new AppException('VALIDATION_FAILED', 'ต้องแนบไฟล์เรซูเม่', 400, [
      { field: RESUME_FILE_FIELD, issue: 'REQUIRED' },
    ]);
  }
  if (file.buffer.length > RESUME_MAX_BYTES) {
    throw new AppException('FILE_TOO_LARGE', 'ไฟล์เรซูเม่ต้องไม่เกิน 5 MB', 400, [
      { field: RESUME_FILE_FIELD, issue: 'MAX_5_MB' },
    ]);
  }
  const detected = await detectFileType(file.buffer);
  if (!detected || detected.mime !== RESUME_MIME) {
    throw new AppException('FILE_TYPE_NOT_ALLOWED', 'เรซูเม่ต้องเป็นไฟล์ PDF เท่านั้น', 400, [
      { field: RESUME_FILE_FIELD, issue: 'PDF_ONLY' },
    ]);
  }
}
