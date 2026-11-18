#!/usr/bin/env node
/**
 * ตรวจว่า object storage (RustFS ในเครื่อง หรือ Cloudflare R2) ใช้งานได้ตามที่ระบบเราพึ่งพา
 *
 *   pnpm storage:check                               # ใช้ค่า S3_* จาก environment หรือ .env ที่ราก repo
 *   pnpm storage:check -- --env .env.r2              # ใช้ไฟล์ env อื่น (เช่น ค่าของ R2) โดยไม่แก้ .env หลัก
 *   pnpm storage:check -- --skip-public              # ข้ามการตรวจ public bucket (ยังไม่ได้เปิดสาธารณะ)
 *
 * ตัวแปรที่ใช้: S3_ENDPOINT, S3_REGION (ค่าเริ่มต้น auto), S3_ACCESS_KEY, S3_SECRET_KEY,
 *   S3_BUCKET_PRIVATE, S3_BUCKET_PUBLIC, S3_PUBLIC_BASE_URL (ไม่บังคับ: URL สาธารณะของ public bucket เช่น https://pub-xxxx.r2.dev)
 *
 * ปลอดภัย:
 * - ไม่สร้าง/แก้ bucket หรือ policy (bucket ต้องมีอยู่แล้ว) เขียนเฉพาะ key ภายใต้ `__storage-check/<uuid>/` แล้วลบทิ้งทุกครั้ง แม้เทสต์ล้ม
 * - ไม่พิมพ์ access key / secret ออกหน้าจอ (แสดงเฉพาะโฮสต์ของ endpoint และชื่อ bucket)
 * - ใช้ SDK และคำสั่งชุดเดียวกับ S3StorageService (Lifecycle) และ CompanyStorageService (Identity)
 *
 * ผลลัพธ์: PASS/FAIL ต่อข้อ พร้อมคำแนะนำเมื่อล้ม; exit code 1 ถ้ามีข้อใดล้ม
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');

const root = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };

function loadEnvFile(file) {
  if (!fs.existsSync(file)) return false;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match && process.env[match[1]] === undefined) process.env[match[1]] = match[2];
  }
  return true;
}

function fail(message) {
  console.error(`check-storage: ${message}`);
  process.exit(2);
}

const envOption = option('--env');
if (envOption) {
  if (!loadEnvFile(path.resolve(process.cwd(), envOption))) fail(`ไม่พบไฟล์ env: ${envOption}`);
}
loadEnvFile(path.join(root, '.env'));

const endpoint = (process.env.S3_ENDPOINT || '').replace(/\/$/, '');
const region = process.env.S3_REGION || 'auto';
const accessKeyId = process.env.S3_ACCESS_KEY;
const secretAccessKey = process.env.S3_SECRET_KEY;
const privateBucket = process.env.S3_BUCKET_PRIVATE || 'internpath-private';
const publicBucket = process.env.S3_BUCKET_PUBLIC || 'internpath-public';
const publicBase = (process.env.S3_PUBLIC_BASE_URL || '').replace(/\/$/, '');
if (!endpoint || !accessKeyId || !secretAccessKey) fail('ไม่พบ S3_ENDPOINT / S3_ACCESS_KEY / S3_SECRET_KEY');

let endpointHost;
try { endpointHost = new URL(endpoint).host; } catch { fail('S3_ENDPOINT อ่านไม่ได้'); }

const sdk = createRequire(path.join(root, 'apps/lifecycle/package.json'))('@aws-sdk/client-s3');
const { getSignedUrl } = createRequire(path.join(root, 'apps/lifecycle/package.json'))('@aws-sdk/s3-request-presigner');
const client = new sdk.S3Client({ endpoint, region, forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });

const results = [];
const created = []; // { bucket, key } ที่ต้องลบตอนจบ
const prefix = `__storage-check/${crypto.randomUUID()}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const get = (url) => fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'manual' });

function record(name, ok, detail = '', hint = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  — ${detail}` : ''}`);
  if (!ok && hint) console.log(`      คำแนะนำ: ${hint}`);
}

async function step(name, fn, hint) {
  try {
    const out = await fn();
    record(name, out.ok, out.detail, out.ok ? '' : hint || out.hint);
  } catch (error) {
    // HEAD ไม่มี body ทำให้ SDK ตั้งชื่อ error ไม่ได้ (Unknown/NotFound) — แสดง HTTP status แทนเพื่อแยก 403 (credentials/สิทธิ์) กับ 404 (ไม่มี bucket)
    const status = error.$metadata && error.$metadata.httpStatusCode;
    const reason = status === 403 ? ' (HTTP 403: credentials ผิดหรือไม่มีสิทธิ์)' : status === 404 ? ' (HTTP 404: ไม่พบ bucket)' : status ? ` (HTTP ${status})` : '';
    record(name, false, `${error.name}${reason}: ${String(error.message).slice(0, 120)}`, hint);
  }
}

async function put(bucket, key, body, contentType) {
  await client.send(new sdk.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType }));
  created.push({ bucket, key });
}

async function main() {
  console.log(`check-storage: endpoint=${endpointHost} region=${region} private=${privateBucket} public=${flag('--skip-public') ? '(ข้าม)' : publicBucket}`);
  console.log(`check-storage: เขียนเฉพาะ ${prefix}/ แล้วลบทิ้งตอนจบ\n`);

  // 0) เชื่อมต่อและ bucket ต้องมีอยู่แล้ว
  let reachable = true;
  for (const bucket of flag('--skip-public') ? [privateBucket] : [privateBucket, publicBucket]) {
    await step(`bucket "${bucket}" มีอยู่และเข้าถึงได้ด้วย credentials นี้`, async () => {
      await client.send(new sdk.HeadBucketCommand({ Bucket: bucket }));
      return { ok: true };
    }, 'ตรวจชื่อ bucket, สิทธิ์ของ token (ต้องมี Object Read & Write ของ bucket นี้) และ S3_ENDPOINT/S3_REGION; R2 ต้องสร้าง bucket ในแดชบอร์ดก่อน');
    if (!results[results.length - 1].ok) reachable = false;
  }
  if (!reachable) { console.log('\nหยุด: เข้าถึง bucket ไม่ได้ จึงไม่ตรวจข้อถัดไป'); return; }

  // 1) Private bucket: อัปโหลด → Signed URL → เปิดโดยไม่มี credentials
  const key = `${prefix}/resume-${crypto.randomUUID()}.pdf`;
  const pdf = Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(5 * 1024 * 1024 - 20), Buffer.from('\n%%EOF\n')]);
  await step('อัปโหลดไฟล์ PDF 5 MB (ขนาดสูงสุดของเรา) ลง Private Bucket', async () => {
    await put(privateBucket, key, pdf, 'application/pdf');
    return { ok: true, detail: `${(pdf.length / 1048576).toFixed(2)} MB` };
  }, 'ตรวจสิทธิ์เขียนของ token และขนาดไฟล์สูงสุดที่ endpoint รับ');

  const signed = () => getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: privateBucket, Key: key }), { expiresIn: 600 });
  let url;
  await step('Signed URL (อายุ 600 วินาที) เปิดได้โดยไม่มี credentials และได้ไฟล์ตรงกันทุกไบต์ + Content-Type ถูก', async () => {
    url = await signed();
    const res = await get(url);
    const body = Buffer.from(await res.arrayBuffer());
    const type = res.headers.get('content-type') || '';
    return { ok: res.status === 200 && body.equals(pdf) && type.startsWith('application/pdf'), detail: `status ${res.status}, ${body.length} ไบต์, ${type}` };
  }, 'ถ้าได้ 403: ตรวจนาฬิกาเครื่อง (เวลาเพี้ยนทำให้ลายเซ็นใช้ไม่ได้) และ region ที่ตั้งตรงกับ endpoint');

  await step('Signed URL ที่ลายเซ็นถูกแก้ ต้องถูกปฏิเสธ', async () => {
    const res = await get(url.replace(/X-Amz-Signature=[0-9a-f]{6}/, 'X-Amz-Signature=000000'));
    return { ok: res.status === 403, detail: `status ${res.status}` };
  }, 'ถ้าได้ 200 แปลว่า endpoint ไม่ตรวจลายเซ็น: ห้ามใช้เก็บข้อมูลจริง');

  await step('Signed URL หมดอายุแล้วต้องถูกปฏิเสธ (ทดสอบด้วยอายุ 2 วินาที)', async () => {
    const short = await getSignedUrl(client, new sdk.GetObjectCommand({ Bucket: privateBucket, Key: key }), { expiresIn: 2 });
    const before = await get(short);
    await before.arrayBuffer();
    await sleep(4500);
    const after = await get(short);
    return { ok: before.status === 200 && after.status === 403, detail: `ก่อนหมดอายุ ${before.status}, หลัง ${after.status}` };
  }, 'ถ้าหลังหมดอายุยังได้ 200 ลิงก์ดาวน์โหลดเรซูเม่จะใช้ได้ตลอด (ผิดกติกา Signed URL ~10 นาที)');

  await step('เข้า Private Bucket ตรง ๆ โดยไม่เซ็น ต้องถูกปฏิเสธ (UAT-42)', async () => {
    const res = await get(`${endpoint}/${privateBucket}/${key}`);
    return { ok: res.status === 403 || res.status === 401, detail: `status ${res.status}` };
  }, 'Private Bucket ห้ามเปิดสาธารณะ: ตรวจการตั้งค่า public access / policy ของ bucket นี้');

  await step('ลบไฟล์แล้ว Signed URL เดิมต้องได้ 404 และลบซ้ำต้องไม่ error (idempotent)', async () => {
    await client.send(new sdk.DeleteObjectCommand({ Bucket: privateBucket, Key: key }));
    await client.send(new sdk.DeleteObjectCommand({ Bucket: privateBucket, Key: key }));
    const res = await get(url);
    await res.arrayBuffer();
    return { ok: res.status === 404, detail: `status ${res.status}` };
  }, 'การลบเรซูเม่ตามคำขอลบบัญชี (README 5.11) ต้องลบไฟล์จริงและลองซ้ำได้');

  // 2) Public bucket: โลโก้บริษัทต้องอ่านได้โดยไม่ต้องเซ็น
  if (flag('--skip-public')) {
    console.log('ข้าม: ตรวจ public bucket (--skip-public)');
  } else {
    const logoKey = `${prefix}/logo-${crypto.randomUUID()}.png`;
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(2048)]);
    await step('อัปโหลดโลโก้ลง Public Bucket', async () => {
      await put(publicBucket, logoKey, png, 'image/png');
      return { ok: true };
    }, 'ตรวจสิทธิ์เขียนของ token กับ public bucket');
    const publicUrl = `${publicBase || `${endpoint}/${publicBucket}`}/${logoKey.split('/').map(encodeURIComponent).join('/')}`;
    await step('โลโก้อ่านได้โดยไม่ต้องเซ็น (URL ที่ Identity จะส่งให้หน้าเว็บ) และ Content-Type ถูก', async () => {
      const res = await get(publicUrl);
      const body = Buffer.from(await res.arrayBuffer());
      const type = res.headers.get('content-type') || '';
      return { ok: res.status === 200 && body.equals(png) && type.startsWith('image/png'), detail: `status ${res.status}, ${type}` };
    }, publicBase
      ? 'URL สาธารณะที่ตั้งไว้ (S3_PUBLIC_BASE_URL) ใช้ไม่ได้: ตรวจว่าเปิดการเข้าถึงสาธารณะของ public bucket แล้ว และ URL ชี้ถูก bucket'
      : 'ยังไม่ได้ตั้ง S3_PUBLIC_BASE_URL: ในเครื่อง (RustFS) รัน `pnpm infra:init-buckets` เพื่อตั้ง policy; บน R2 ต้องเปิดโดเมน r2.dev หรือโดเมนของเราในแดชบอร์ด (R2 ตั้ง bucket policy ไม่ได้) แล้วตั้ง S3_PUBLIC_BASE_URL');
  }
}

async function cleanup() {
  let failed = 0;
  for (const { bucket, key } of created) {
    try { await client.send(new sdk.DeleteObjectCommand({ Bucket: bucket, Key: key })); } catch { failed += 1; }
  }
  if (failed) console.log(`\nเตือน: ลบไฟล์ทดสอบไม่สำเร็จ ${failed} รายการ (ค้นหา key ขึ้นต้นด้วย ${prefix}/ แล้วลบเอง)`);
}

main()
  .catch((error) => { console.error(`check-storage: ${error.name}: ${error.message}`); results.push({ name: 'script', ok: false }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nสรุป: ${results.length - failed}/${results.length} ผ่าน${failed ? ` — ล้ม ${failed} ข้อ` : ''}`);
    process.exit(failed ? 1 : 0);
  });
