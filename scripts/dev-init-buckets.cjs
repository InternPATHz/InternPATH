#!/usr/bin/env node
/**
 * สร้าง bucket สำหรับเครื่อง dev (RustFS ใน docker-compose) — โค้ดของ Service ไม่สร้าง bucket ให้เอง
 *
 *   pnpm infra:init-buckets      (ต้อง `pnpm infra:up` ก่อน)
 *
 * - สร้าง `S3_BUCKET_PUBLIC` (โลโก้บริษัท: อ่านได้โดยไม่ต้องเซ็น) และ `S3_BUCKET_PRIVATE` (เรซูเม่/เอกสาร/ใบรับรอง: ต้องใช้ Signed URL)
 * - ตั้ง bucket policy ให้ Public bucket อ่านแบบไม่เซ็นได้ ส่วน Private ไม่ตั้ง (ปิดโดยค่าเริ่มต้น)
 * - ใช้ region `us-east-1` ตอนสร้าง เพราะ `CreateBucket` ด้วย `S3_REGION=auto` ถูกปฏิเสธ (InvalidLocationConstraint)
 *   ส่วนการอ่าน/เขียน/Signed URL ของ Service ใช้ `auto` ได้ตามปกติ
 * - รันซ้ำได้ (bucket ที่มีอยู่แล้วข้าม; policy ตั้งซ้ำได้)
 * - อ่านค่า S3_* จาก environment หรือ .env ที่ราก repo
 * - ปฏิเสธเมื่อ NODE_ENV=production หรือ S3_ENDPOINT ไม่ใช่เครื่องนี้ (กันตั้ง policy สาธารณะบน Cloudflare R2 จริงโดยพลาด)
 */
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');

function loadEnvFile() {
  const file = path.join(root, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
}

function fail(message) {
  console.error(`init-buckets: ${message}`);
  process.exit(1);
}

async function main() {
  if (process.env.NODE_ENV === 'production') fail('ปฏิเสธเมื่อ NODE_ENV=production');
  loadEnvFile();

  const endpoint = process.env.S3_ENDPOINT;
  const accessKeyId = process.env.S3_ACCESS_KEY;
  const secretAccessKey = process.env.S3_SECRET_KEY;
  const publicBucket = process.env.S3_BUCKET_PUBLIC || 'internpath-public';
  const privateBucket = process.env.S3_BUCKET_PRIVATE || 'internpath-private';
  if (!endpoint || !accessKeyId || !secretAccessKey) fail('ไม่พบ S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY');

  let host;
  try { host = new URL(endpoint).hostname; } catch { fail('S3_ENDPOINT อ่านไม่ได้'); }
  if (!['localhost', '127.0.0.1', '::1', '[::1]'].includes(host)) fail(`ปฏิเสธ: S3_ENDPOINT อยู่ที่ ${host} ไม่ใช่เครื่องนี้`);

  const sdk = createRequire(path.join(root, 'apps/lifecycle/package.json'))('@aws-sdk/client-s3');
  const client = new sdk.S3Client({
    endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey },
  });

  for (const bucket of [publicBucket, privateBucket]) {
    // CreateBucket ซ้ำใน us-east-1 ตอบสำเร็จได้ (เหมือน AWS S3) จึงเช็คก่อนเพื่อรายงานให้ตรงความจริง
    const exists = await client.send(new sdk.HeadBucketCommand({ Bucket: bucket })).then(() => true, () => false);
    if (exists) { console.log(`init-buckets: มี ${bucket} อยู่แล้ว`); continue; }
    try {
      await client.send(new sdk.CreateBucketCommand({ Bucket: bucket }));
      console.log(`init-buckets: สร้าง ${bucket}`);
    } catch (error) {
      if (!['BucketAlreadyOwnedByYou', 'BucketAlreadyExists'].includes(error.name)) fail(`สร้าง ${bucket} ไม่สำเร็จ: ${error.name}`);
      console.log(`init-buckets: มี ${bucket} อยู่แล้ว`);
    }
  }

  await client.send(new sdk.PutBucketPolicyCommand({
    Bucket: publicBucket,
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [{ Effect: 'Allow', Principal: { AWS: ['*'] }, Action: ['s3:GetObject'], Resource: [`arn:aws:s3:::${publicBucket}/*`] }],
    }),
  }));
  console.log(`init-buckets: ตั้ง policy อ่านสาธารณะให้ ${publicBucket} (${privateBucket} ไม่เปิด)`);
}

main().catch((error) => fail(error instanceof Error ? `${error.name}: ${error.message}` : String(error)));
