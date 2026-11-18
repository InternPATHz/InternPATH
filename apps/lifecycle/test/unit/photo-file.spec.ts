import { expect } from 'chai';
import { fromBuffer } from 'file-type';
import { AppException } from '@internpath/common';
import { PHOTO_MAX_BYTES, preparePhoto } from '../../src/modules/profiles/photo-file';
import { SAMPLE_FILES } from '../support/profile-resume-fakes';
import { sampleJpeg, samplePng, sampleWebp } from '../support/photo-samples';

const SECRETS = /SECRET-(GPS|TEXT)/;

async function rejects(buffer: Buffer | undefined): Promise<AppException> {
  try {
    await preparePhoto(buffer ? { buffer } : undefined);
  } catch (error) {
    return error as AppException;
  }
  throw new Error('expected rejection');
}

describe('รูปโปรไฟล์ — ตรวจไฟล์และล้าง metadata (Unit, api-contract §7.1)', () => {
  for (const [name, make, mime, ext] of [
    ['JPEG', sampleJpeg, 'image/jpeg', 'jpg'],
    ['PNG', samplePng, 'image/png', 'png'],
    ['WebP', sampleWebp, 'image/webp', 'webp'],
  ] as const) {
    it(`${name}: ล้าง EXIF/GPS/ข้อความออกหมด และยังเป็นไฟล์ชนิดเดิม`, async () => {
      const input = make();
      expect(input.toString('latin1')).to.match(SECRETS);
      const out = await preparePhoto({ buffer: input });
      expect(out).to.include({ mime, extension: ext });
      expect(out.buffer.toString('latin1')).to.not.match(SECRETS);
      expect((await fromBuffer(out.buffer))?.mime).to.equal(mime);
      expect(out.buffer.length).to.be.lessThan(input.length);
    });
  }

  it('JPEG: เก็บ JFIF/ตาราง/ข้อมูลภาพหลัง SOS ครบ', async () => {
    const out = (await preparePhoto({ buffer: sampleJpeg() })).buffer;
    expect(out.subarray(0, 2)).to.deep.equal(Buffer.from([0xff, 0xd8]));
    expect(out.includes(Buffer.from('JFIF', 'latin1'))).to.equal(true);
    expect(out.subarray(-8)).to.deep.equal(Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78, 0xff, 0xd9]));
  });

  it('WebP: ปิดธง EXIF/XMP ใน VP8X และขนาด RIFF ตรงกับไฟล์', async () => {
    const out = (await preparePhoto({ buffer: sampleWebp() })).buffer;
    expect(out.readUInt32LE(4)).to.equal(out.length - 8);
    const vp8x = out.indexOf(Buffer.from('VP8X', 'latin1'));
    expect(out[vp8x + 8] & 0x0c).to.equal(0);
  });

  it('ไม่มีไฟล์ ⇒ VALIDATION_FAILED • เกิน 2 MB ⇒ FILE_TOO_LARGE • PDF/EXE ⇒ FILE_TYPE_NOT_ALLOWED • JPEG เสีย ⇒ INVALID_IMAGE', async () => {
    expect((await rejects(undefined)).code).to.equal('VALIDATION_FAILED');
    const big = Buffer.concat([sampleJpeg(), Buffer.alloc(PHOTO_MAX_BYTES)]);
    expect((await rejects(big)).code).to.equal('FILE_TOO_LARGE');
    expect((await rejects(SAMPLE_FILES.pdf())).code).to.equal('FILE_TYPE_NOT_ALLOWED');
    expect((await rejects(SAMPLE_FILES.exe())).code).to.equal('FILE_TYPE_NOT_ALLOWED');
    const broken = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x7f, 0xff]), Buffer.alloc(10)]);
    const error = await rejects(broken);
    expect(error.code).to.equal('FILE_TYPE_NOT_ALLOWED');
    expect(error.getResponse()).to.satisfy((r: unknown) => JSON.stringify(r).includes('INVALID_IMAGE'));
  });
});
