import { BadRequestException, PayloadTooLargeException } from '@nestjs/common';
import { AppException } from '@internpath/common';
import { expect } from 'chai';
import { RESUME_MAX_BYTES, assertResumeFile } from '../../src/modules/resumes/resume-file';
import { mapUploadError } from '../../src/modules/resumes/upload-error.interceptor';
import { SAMPLE_FILES } from '../support/profile-resume-fakes';

async function codeOf(run: () => Promise<unknown>): Promise<{ code?: string; status?: number }> {
  try {
    await run();
  } catch (error) {
    const e = error as AppException;
    return { code: e.code, status: e.getStatus?.() };
  }
  return {};
}

describe('ตรวจไฟล์เรซูเม่ (README §5.9, UAT-42)', () => {
  it('รับ PDF จริง', async () => {
    await assertResumeFile({ buffer: SAMPLE_FILES.pdf() });
  });

  it('รับ PDF ขนาดพอดี 5 MB', async () => {
    const buffer = Buffer.concat([SAMPLE_FILES.pdf(), Buffer.alloc(RESUME_MAX_BYTES - SAMPLE_FILES.pdf().length, 0x20)]);
    expect(buffer.length).to.equal(RESUME_MAX_BYTES);
    await assertResumeFile({ buffer });
  });

  it('ไฟล์ .exe ที่เปลี่ยนนามสกุลเป็น .pdf ⇒ 400 FILE_TYPE_NOT_ALLOWED (ตรวจจากเนื้อไฟล์ ไม่เชื่อนามสกุล)', async () => {
    expect(await codeOf(() => assertResumeFile({ buffer: SAMPLE_FILES.exe() }))).to.deep.equal({
      code: 'FILE_TYPE_NOT_ALLOWED',
      status: 400,
    });
  });

  it('รูปภาพ/ข้อความธรรมดา ⇒ 400 FILE_TYPE_NOT_ALLOWED', async () => {
    for (const buffer of [SAMPLE_FILES.png(), SAMPLE_FILES.text()]) {
      expect((await codeOf(() => assertResumeFile({ buffer }))).code).to.equal('FILE_TYPE_NOT_ALLOWED');
    }
  });

  it('ไฟล์ > 5 MB ⇒ 400 FILE_TOO_LARGE', async () => {
    expect(await codeOf(() => assertResumeFile({ buffer: SAMPLE_FILES.oversizedPdf() }))).to.deep.equal({
      code: 'FILE_TOO_LARGE',
      status: 400,
    });
  });

  it('ไม่แนบไฟล์หรือไฟล์ว่าง ⇒ 400 VALIDATION_FAILED', async () => {
    expect((await codeOf(() => assertResumeFile(undefined))).code).to.equal('VALIDATION_FAILED');
    expect((await codeOf(() => assertResumeFile({ buffer: Buffer.alloc(0) }))).code).to.equal('VALIDATION_FAILED');
  });

  it('แปลง error ของ multer เป็น code ตาม api-contract §2', () => {
    const tooLarge = mapUploadError(new PayloadTooLargeException()) as AppException;
    expect(tooLarge.code).to.equal('FILE_TOO_LARGE');
    expect(tooLarge.getStatus()).to.equal(400);
    expect((mapUploadError(new BadRequestException('Unexpected field')) as AppException).code).to.equal('VALIDATION_FAILED');
    const app = new AppException('NOT_FOUND', 'x', 404);
    expect(mapUploadError(app)).to.equal(app);
    const other = new Error('boom');
    expect(mapUploadError(other)).to.equal(other);
  });
});
