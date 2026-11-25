/**
 * ตรวจชนิดไฟล์จากเนื้อไฟล์จริงด้วย `file-type` (21.x เป็น ESM อย่างเดียว)
 * แอปนี้คอมไพล์เป็น CommonJS — `import()` ปกติจะถูก TypeScript แปลงเป็น `require()` ซึ่งโหลด ESM ไม่ได้
 * จึงเรียกผ่าน `new Function` ให้เป็น dynamic import จริงตอนรัน (รุ่น 16.x เดิมมีช่องโหว่ GHSA-5v7r-6r5c-r473)
 */
export type DetectedFileType = { ext: string; mime: string };

type FileTypeModule = { fileTypeFromBuffer(input: Uint8Array | ArrayBuffer): Promise<DetectedFileType | undefined> };

const importEsm = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<FileTypeModule>;

let loaded: Promise<FileTypeModule> | undefined;

export async function detectFileType(buffer: Buffer): Promise<DetectedFileType | undefined> {
  loaded ??= importEsm('file-type');
  const { fileTypeFromBuffer } = await loaded;
  return fileTypeFromBuffer(buffer);
}
