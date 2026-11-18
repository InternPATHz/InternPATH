/** รูปตัวอย่างสร้างด้วยมือ (ไม่ต้องมีไฟล์) — มี metadata ปลอมที่ต้องถูกล้าง: คำว่า SECRET-GPS / SECRET-TEXT */

const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
const u32be = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
const u32le = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const jpegSegment = (marker: number, body: Buffer) => Buffer.concat([Buffer.from([0xff, marker]), u16(body.length + 2), body]);

export function sampleJpeg(): Buffer {
  return Buffer.concat([
    Buffer.from([0xff, 0xd8]),
    jpegSegment(0xe0, Buffer.from('JFIF\0\x01\x01\0\0\x01\0\x01\0\0', 'latin1')),
    jpegSegment(0xe1, Buffer.from('Exif\0\0SECRET-GPS 13.7563N 100.5018E', 'latin1')),
    jpegSegment(0xed, Buffer.from('Photoshop 3.0\0SECRET-TEXT iptc', 'latin1')),
    jpegSegment(0xfe, Buffer.from('SECRET-TEXT comment', 'latin1')),
    jpegSegment(0xdb, Buffer.alloc(65, 1)),
    jpegSegment(0xda, Buffer.from([1, 1, 0, 0, 0x3f, 0])),
    Buffer.from([0x12, 0x34, 0x56, 0xff, 0x00, 0x78]),
    Buffer.from([0xff, 0xd9]),
  ]);
}

const pngChunk = (type: string, data: Buffer) => Buffer.concat([u32be(data.length), Buffer.from(type, 'latin1'), data, u32be(0)]);

export function samplePng(): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    pngChunk('tEXt', Buffer.from('Author\0SECRET-TEXT', 'latin1')),
    pngChunk('eXIf', Buffer.from('MM\0*SECRET-GPS', 'latin1')),
    pngChunk('IDAT', Buffer.from([0x78, 0x9c, 0x63, 0, 0, 0, 2, 0, 1])),
    pngChunk('iTXt', Buffer.from('Comment\0\0\0\0\0SECRET-TEXT', 'latin1')),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

const webpChunk = (type: string, data: Buffer) =>
  Buffer.concat([Buffer.from(type, 'latin1'), u32le(data.length), data, data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0)]);

export function sampleWebp(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x0c; // EXIF + XMP flags
  const body = Buffer.concat([
    webpChunk('VP8X', vp8x),
    webpChunk('VP8 ', Buffer.from([0x2f, 0, 0, 0, 0x9d, 0x01, 0x2a, 1, 0, 1, 0])),
    webpChunk('EXIF', Buffer.from('MM\0*SECRET-GPS', 'latin1')),
    webpChunk('XMP ', Buffer.from('<x:xmpmeta>SECRET-TEXT</x:xmpmeta>', 'latin1')),
  ]);
  return Buffer.concat([Buffer.from('RIFF', 'latin1'), u32le(body.length + 4), Buffer.from('WEBP', 'latin1'), body]);
}
