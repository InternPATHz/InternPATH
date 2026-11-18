import { fromBuffer } from 'file-type';
import { AppException } from '@internpath/common';

/** README §5.9 / api-contract §7.1 — รูปโปรไฟล์ jpg / png / webp ≤ 2 MB */
export const PHOTO_MAX_BYTES = 2 * 1024 * 1024;
export const PHOTO_FILE_FIELD = 'file';

export const PHOTO_TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;
export type PhotoMime = keyof typeof PHOTO_TYPES;

export interface UploadedPhotoFile {
  buffer: Buffer;
}

export interface CleanPhoto {
  mime: PhotoMime;
  extension: string;
  /** ไฟล์ที่ตัด metadata (EXIF/GPS/XMP/IPTC/ข้อความ) ออกแล้ว */
  buffer: Buffer;
}

const photoError = (code: 'VALIDATION_FAILED' | 'FILE_TOO_LARGE' | 'FILE_TYPE_NOT_ALLOWED', message: string, issue: string) =>
  new AppException(code, message, 400, [{ field: PHOTO_FILE_FIELD, issue }]);

/**
 * ตรวจรูปฝั่ง Server: มีไฟล์, ≤ 2 MB, **MIME จริงจากเนื้อไฟล์** เป็น jpg/png/webp (ไม่เชื่อนามสกุล/Content-Type)
 * แล้ว **ล้าง metadata** (EXIF รวมพิกัด GPS ฯลฯ — PM ขอ 18 พ.ย.) ก่อนเก็บ • ไฟล์โครงสร้างเสีย ⇒ `FILE_TYPE_NOT_ALLOWED`
 */
export async function preparePhoto(file: UploadedPhotoFile | undefined): Promise<CleanPhoto> {
  if (!file || !file.buffer || file.buffer.length === 0) {
    throw photoError('VALIDATION_FAILED', 'ต้องแนบไฟล์รูป', 'REQUIRED');
  }
  if (file.buffer.length > PHOTO_MAX_BYTES) {
    throw photoError('FILE_TOO_LARGE', 'รูปโปรไฟล์ต้องไม่เกิน 2 MB', 'MAX_2_MB');
  }
  const detected = await fromBuffer(file.buffer);
  const mime = detected?.mime as PhotoMime | undefined;
  if (!mime || !(mime in PHOTO_TYPES)) {
    throw photoError('FILE_TYPE_NOT_ALLOWED', 'รูปโปรไฟล์ต้องเป็น jpg, png หรือ webp', 'IMAGE_ONLY');
  }
  let buffer: Buffer;
  try {
    buffer = stripImageMetadata(file.buffer, mime);
  } catch {
    throw photoError('FILE_TYPE_NOT_ALLOWED', 'ไฟล์รูปเสียหรืออ่านไม่ได้', 'INVALID_IMAGE');
  }
  return { mime, extension: PHOTO_TYPES[mime], buffer };
}

/** ตัด metadata ตามชนิดไฟล์ — ไม่ถอดรหัสภาพ (ไม่ต้องใช้ไลบรารี native) */
export function stripImageMetadata(input: Buffer, mime: PhotoMime): Buffer {
  switch (mime) {
    case 'image/jpeg':
      return stripJpeg(input);
    case 'image/png':
      return stripPng(input);
    case 'image/webp':
      return stripWebp(input);
  }
}

// ---------------------------------------------------------------- JPEG

/** APP1 (EXIF/XMP), APP2–APP15 ยกเว้น APP14 (Adobe สี) และ COM — เก็บ APP0 (JFIF), APP2 ICC ตัดทิ้งด้วยเพื่อความง่าย */
const JPEG_KEEP_APP = new Set([0xe0, 0xee]);

function stripJpeg(input: Buffer): Buffer {
  if (input[0] !== 0xff || input[1] !== 0xd8) throw new Error('not jpeg');
  const out: Buffer[] = [input.subarray(0, 2)];
  let i = 2;
  while (i < input.length) {
    if (input[i] !== 0xff) throw new Error('bad marker');
    const marker = input[i + 1];
    if (marker === 0xff) {
      i += 1; // fill byte
      continue;
    }
    if (marker === 0xda) {
      // SOS — ที่เหลือคือข้อมูลภาพจนถึง EOI เก็บทั้งหมด
      out.push(input.subarray(i));
      return Buffer.concat(out);
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      out.push(input.subarray(i, i + 2));
      i += 2;
      continue;
    }
    if (i + 4 > input.length) throw new Error('truncated');
    const length = input.readUInt16BE(i + 2);
    if (length < 2 || i + 2 + length > input.length) throw new Error('bad length');
    const segment = input.subarray(i, i + 2 + length);
    const isApp = marker >= 0xe0 && marker <= 0xef;
    const drop = (isApp && !JPEG_KEEP_APP.has(marker)) || marker === 0xfe;
    if (!drop) out.push(segment);
    i += 2 + length;
  }
  throw new Error('no image data');
}

// ---------------------------------------------------------------- PNG

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
/** chunk ข้อความ/เวลา/EXIF ที่อาจมีข้อมูลส่วนบุคคล */
const PNG_DROP = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt', 'tIME']);

function stripPng(input: Buffer): Buffer {
  if (!input.subarray(0, 8).equals(PNG_SIGNATURE)) throw new Error('not png');
  const out: Buffer[] = [PNG_SIGNATURE];
  let i = 8;
  while (i < input.length) {
    if (i + 12 > input.length) throw new Error('truncated');
    const length = input.readUInt32BE(i);
    const type = input.toString('latin1', i + 4, i + 8);
    const end = i + 12 + length;
    if (end > input.length) throw new Error('bad length');
    if (!PNG_DROP.has(type)) out.push(input.subarray(i, end));
    i = end;
    if (type === 'IEND') return Buffer.concat(out);
  }
  throw new Error('no IEND');
}

// ---------------------------------------------------------------- WebP

const WEBP_DROP = new Set(['EXIF', 'XMP ']);
const VP8X_EXIF_FLAG = 0x08;
const VP8X_XMP_FLAG = 0x04;

function stripWebp(input: Buffer): Buffer {
  if (input.toString('latin1', 0, 4) !== 'RIFF' || input.toString('latin1', 8, 12) !== 'WEBP') throw new Error('not webp');
  const riffEnd = Math.min(input.length, 8 + input.readUInt32LE(4));
  const chunks: Buffer[] = [];
  let i = 12;
  while (i + 8 <= riffEnd) {
    const type = input.toString('latin1', i, i + 4);
    const size = input.readUInt32LE(i + 4);
    const end = i + 8 + size + (size % 2); // chunk ขนาดคี่มี padding 1 byte
    if (end > riffEnd + 1) throw new Error('bad chunk');
    if (!WEBP_DROP.has(type)) {
      const chunk = Buffer.from(input.subarray(i, Math.min(end, riffEnd)));
      if (type === 'VP8X' && chunk.length > 8) chunk[8] &= ~(VP8X_EXIF_FLAG | VP8X_XMP_FLAG);
      chunks.push(chunk);
    }
    i = end;
  }
  if (!chunks.length) throw new Error('no image data');
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(12);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(body.length + 4, 4);
  header.write('WEBP', 8, 'latin1');
  return Buffer.concat([header, body]);
}
