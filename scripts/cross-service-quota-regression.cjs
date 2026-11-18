/**
 * Cross-service regression: Job Internal API (quota) <-> Lifecycle (lease + repair) over real HTTP
 * (QIR-01 / QIR-03 / Termination-before-Repair; api-contract §9). 22 checks, ~6 minutes (waits for Scheduler ticks).
 *
 * - เปิด Job (:3002) และ Lifecycle (:3004) เป็น process จริง บนฐานข้อมูล Postgres และ RabbitMQ vhost ที่สร้างใหม่ชั่วคราว
 *   (ไม่แตะฐาน/คิวของ dev) แล้วลบทิ้งตอนจบ; Identity/Gateway ไม่เกี่ยว (ออก JWT ของ HR เองด้วยคีย์ใหม่ชั่วคราว)
 * - เตรียมก่อนรัน (ครั้งแรก/หลังแก้ schema):
 *     pnpm install && pnpm --filter "./libs/*" build
 *     pnpm --filter @internpath/job prisma:generate && pnpm --filter @internpath/lifecycle prisma:generate
 *     docker compose --profile infra up -d postgres rabbitmq     (รอจน healthy)
 *     ปิด dev service บนพอร์ต 3002/3004 และต้องมี secret ใน .env: JOB_SERVICE_SECRET_LIFECYCLE, LIFECYCLE_SERVICE_SECRET_JOB
 * - รัน:  node scripts/cross-service-quota-regression.cjs        (exit 0 = ผ่านทั้งหมด)
 * - ต้องมี Job Internal API (apps/job/src/modules/internal-jobs) ใน branch ที่รัน
 */
const { createRequire } = require('node:module');
const { spawn, execFileSync } = require('node:child_process');
const { randomUUID, randomBytes, generateKeyPairSync } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LOGDIR = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'xs-quota-'));
const RABBIT_CONTAINER = process.env.RABBITMQ_CONTAINER || 'internpath-rabbitmq-1';
const reqJob = createRequire(path.join(ROOT, 'apps/job/package.json'));
const reqLc = createRequire(path.join(ROOT, 'apps/lifecycle/package.json'));
const { Client } = reqLc('pg');
const jwt = reqLc('jsonwebtoken');
const { PrismaClient: JobPrisma } = reqJob(path.join(ROOT, 'apps/job/generated/client'));
const { PrismaClient: LcPrisma } = reqLc(path.join(ROOT, 'apps/lifecycle/generated/client'));
const { signServiceToken } = reqLc('@internpath/common');

// ---- env from .env (values never printed)
const dotenv = {};
for (const line of fs.readFileSync(path.join(ROOT, '.env'), 'utf8').split(/\r?\n/)) {
  const m = /^([A-Z0-9_]+)=(.*)$/.exec(line);
  if (m) dotenv[m[1]] = m[2].replace(/^"|"$/g, '');
}
// ---- preflight: fail early with a clear message
function preflight() {
  const problems = [];
  if (!fs.existsSync(path.join(ROOT, 'apps/job/src/modules/internal-jobs/internal-jobs.controller.ts'))) {
    problems.push('ไม่พบ Job Internal API (apps/job/src/modules/internal-jobs) — ต้อง merge/เช็กเอาท์โค้ดที่มี quota API ของ Job ก่อน');
  }
  for (const key of ['POSTGRES_PASSWORD', 'RABBITMQ_USER', 'RABBITMQ_PASSWORD', 'JOB_SERVICE_SECRET_LIFECYCLE', 'LIFECYCLE_SERVICE_SECRET_JOB']) {
    if (!dotenv[key]) problems.push(`.env ขาด ${key}`);
  }
  for (const dir of ['apps/job/generated/client', 'apps/lifecycle/generated/client']) {
    if (!fs.existsSync(path.join(ROOT, dir))) problems.push(`ยังไม่ได้ prisma:generate (${dir})`);
  }
  if (problems.length) {
    console.error('PRECONDITION FAILED:\n - ' + problems.join('\n - '));
    process.exit(2);
  }
}
preflight();
const pw = dotenv.POSTGRES_PASSWORD;
const ADMIN = `postgresql://internpath:${pw}@127.0.0.1:5432/postgres`;
const suffix = randomBytes(3).toString('hex');
const JOB_DB = `xs_job_${suffix}`;
const LC_DB = `xs_lc_${suffix}`;
const url = (db) => `postgresql://internpath:${pw}@127.0.0.1:5432/${db}`;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const VHOST = `xs_${suffix}`;
const AMQP = `amqp://${encodeURIComponent(dotenv.RABBITMQ_USER)}:${encodeURIComponent(dotenv.RABBITMQ_PASSWORD)}@127.0.0.1:5672/${VHOST}`;
const oneLine = (pem) => pem.replace(/\r?\n/g, '\\n');

const JOB_SECRET = dotenv.JOB_SERVICE_SECRET_LIFECYCLE;
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, label, ms = 240000, step = 3000) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting: ${label}`);
    await sleep(step);
  }
}

const children = [];
function start(name, cwd, env) {
  const out = fs.openSync(path.join(LOGDIR, `xs-${name}.log`), 'w');
  const child = spawn(process.execPath, [reqLc.resolve('@nestjs/cli/bin/nest.js'), 'start'], {
    cwd,
    env: { ...process.env, ...dotenv, ...env, LOG_LEVEL: 'info' },
    stdio: ['ignore', out, out],
  });
  children.push(child);
  return child;
}

async function main() {
  const admin = new Client({ connectionString: ADMIN });
  await admin.connect();
  for (const db of [JOB_DB, LC_DB]) await admin.query(`CREATE DATABASE ${db}`);
  console.log(`databases: ${JOB_DB}, ${LC_DB}`);
  // isolated RabbitMQ vhost so the temporary services never touch the dev broker's queues
  execFileSync('docker', ['exec', RABBIT_CONTAINER, 'rabbitmqctl', 'add_vhost', VHOST], { stdio: 'pipe' });
  execFileSync('docker', ['exec', RABBIT_CONTAINER, 'rabbitmqctl', 'set_permissions', '-p', VHOST, dotenv.RABBITMQ_USER, '.*', '.*', '.*'], { stdio: 'pipe' });
  execFileSync(process.execPath, [reqLc.resolve('ts-node/dist/bin.js'), 'scripts/provision-topology.ts'], { cwd: path.join(ROOT, 'libs/common'), env: { ...process.env, TS_NODE_TRANSPILE_ONLY: 'true', RABBITMQ_URL: AMQP }, stdio: 'pipe' });
  console.log(`rabbitmq vhost ${VHOST} provisioned`);

  const migrate = (app, req, dbUrl, envKeys) =>
    execFileSync(process.execPath, [req.resolve('prisma/build/index.js'), 'migrate', 'deploy'], {
      cwd: path.join(ROOT, 'apps', app),
      env: { ...process.env, ...Object.fromEntries(envKeys.map((k) => [k, dbUrl])) },
      stdio: 'pipe',
    });
  migrate('job', reqJob, url(JOB_DB), ['JOB_DATABASE_URL', 'JOB_DIRECT_URL']);
  migrate('lifecycle', reqLc, url(LC_DB), ['LIFECYCLE_DATABASE_URL', 'LIFECYCLE_DIRECT_URL']);
  console.log('migrations applied (Job + Lifecycle incl. quota_op_until)');

  const jobDb = new JobPrisma({ datasourceUrl: url(JOB_DB) });
  const lcDb = new LcPrisma({ datasourceUrl: url(LC_DB) });

  // faster scheduler tick for the repair scenarios (config override, 1 minute)
  await lcDb.configOverride.create({ data: { key: 'SCHEDULER_INTERVAL_MINUTES', value: '1' } });

  const companyId = randomUUID();
  const seedJob = (quota, title) =>
    jobDb.job.create({
      data: {
        companyId, createdBy: randomUUID(), currentSubmissionId: randomUUID(), status: 'PUBLISHED',
        entityVersion: 10, version: 4, category: 'TECH_IT', jobTitle: title, description: 'd',
        responsibilities: 'r', qualifications: 'q', location: 'Bangkok', workMode: 'ONSITE', hoursPerWeek: 40,
        allowanceType: 'NONE', internshipPeriodStart: new Date('2027-01-01'), internshipPeriodEnd: new Date('2027-04-01'),
        targetMajors: ['CS'], quota, applicationDeadline: new Date('2099-12-01'),
      },
    });
  const jobA = await seedJob(10, 'XS Job A');
  const jobB = await seedJob(1, 'XS Job B (one seat)');
  const jobC = await seedJob(1, 'XS Job C (one seat)');

  const base = {
    RABBITMQ_URL: AMQP,
    JOB_URL: 'http://127.0.0.1:3002',
    LIFECYCLE_URL: 'http://127.0.0.1:3004',
    JOB_SERVICE_SECRET_LIFECYCLE: JOB_SECRET,
    LIFECYCLE_SERVICE_SECRET_JOB: dotenv.LIFECYCLE_SERVICE_SECRET_JOB,
    IDENTITY_SERVICE_SECRET_LIFECYCLE: dotenv.IDENTITY_SERVICE_SECRET_LIFECYCLE,
    LIFECYCLE_SERVICE_SECRET_IDENTITY: dotenv.LIFECYCLE_SERVICE_SECRET_IDENTITY,
  };
  start('job', path.join(ROOT, 'apps/job'), { ...base, JOB_DATABASE_URL: url(JOB_DB), JOB_DIRECT_URL: url(JOB_DB), PORT: '3002' });
  start('lifecycle', path.join(ROOT, 'apps/lifecycle'), {
    ...base, LIFECYCLE_DATABASE_URL: url(LC_DB), LIFECYCLE_DIRECT_URL: url(LC_DB), PORT: '3004', JWT_PUBLIC_KEY: oneLine(publicKey),
  });
  const healthy = async (port) => {
    try { return (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { return false; }
  };
  await until(() => healthy(3002), 'job health', 120000, 2000);
  await until(() => healthy(3004), 'lifecycle health', 120000, 2000);
  console.log('Job :3002 and Lifecycle :3004 are up');

  const svc = (iss, aud, secret) => signServiceToken({ issuer: iss, audience: aud, secret });
  const jobCall = (jobId, op, body) =>
    fetch(`http://127.0.0.1:3002/internal/v1/jobs/${jobId}/quota/${op}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${svc('lifecycle', 'job', JOB_SECRET)}` },
      body: JSON.stringify(body),
    });
  const hrToken = jwt.sign({ role: 'COMPANY_HR', company_id: companyId }, privateKey, {
    algorithm: 'RS256', subject: randomUUID(), jwtid: randomUUID(), expiresIn: 3600,
  });
  const accept = (id) =>
    fetch(`http://127.0.0.1:3004/v1/hr/applications/${id}/actions/accept`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hrToken}` },
      body: JSON.stringify({ start_date: '2027-01-10', end_date: '2027-03-30' }),
    });
  const seedApp = (jobId, status, extra = {}) =>
    lcDb.application.create({
      data: { jobId, companyId, studentUserId: randomUUID(), advisorUserId: randomUUID(), status, ...extra },
    });
  const jobState = async (jobId, appId) => {
    const [job, r] = await Promise.all([
      jobDb.job.findUniqueOrThrow({ where: { id: jobId } }),
      jobDb.quotaReservation.findUnique({ where: { applicationId: appId } }),
    ]);
    return { reserved: job.quotaReserved, confirmed: job.quotaConfirmed, status: r ? r.status : null };
  };

  // ---------- S1 happy path
  const app1 = await seedApp(jobA.id, 'PENDING');
  let res = await accept(app1.id);
  check('S1 accept ผ่าน Job จริง ⇒ 200 HR_ACCEPTED', res.status === 200, `http ${res.status}`);
  let row = await lcDb.application.findUniqueOrThrow({ where: { id: app1.id } });
  let st = await jobState(jobA.id, app1.id);
  check('S1 Lifecycle ถือโควตา และ lease ถูกคืน', row.status === 'HR_ACCEPTED' && row.quotaReserved === true && row.quotaOpUntil === null, JSON.stringify({ status: row.status, lease: row.quotaOpUntil }));
  check('S1 Job: reservation RESERVED, reserved=1', st.status === 'RESERVED' && st.reserved === 1, JSON.stringify(st));

  // ---------- S2 concurrent accepts on one application over real HTTP
  const app2 = await seedApp(jobA.id, 'PENDING');
  const responses = await Promise.all(Array.from({ length: 6 }, () => accept(app2.id)));
  const codes = responses.map((r) => r.status).sort();
  const ok = codes.filter((c) => c === 200).length;
  row = await lcDb.application.findUniqueOrThrow({ where: { id: app2.id } });
  st = await jobState(jobA.id, app2.id);
  check('S2 accept พร้อมกัน 6 คำขอ ⇒ สำเร็จ 1 ที่เหลือ 409', ok === 1 && codes.filter((c) => c === 409).length === 5, codes.join(','));
  check('S2 Job หักโควตาแค่ 1 (reserved รวม = 2) และตรงกับ Lifecycle', st.status === 'RESERVED' && st.reserved === 2 && row.quotaReserved === true && row.quotaOpUntil === null, JSON.stringify(st));

  // ---------- S3 QIR-01 end state: stale release landed after B succeeded -> repair
  res = await jobCall(jobA.id, 'release', { application_id: app1.id, reason: 'TRANSITION_FAILED' });
  st = await jobState(jobA.id, app1.id);
  check('S3 release เก่ามาถึง Job ⇒ RELEASED ทั้งที่ Lifecycle ยังถือ (สภาพ QIR-01)', res.status === 200 && st.status === 'RELEASED' && st.reserved === 1, JSON.stringify(st));

  // ---------- S4 QIR-03: Lifecycle IN_PROGRESS but Job left RESERVED
  const app3 = await seedApp(jobA.id, 'IN_PROGRESS', { quotaReserved: true });
  res = await jobCall(jobA.id, 'reserve', { application_id: app3.id });
  st = await jobState(jobA.id, app3.id);
  check('S4 เตรียม: Job RESERVED แต่ Lifecycle IN_PROGRESS (ไม่ได้ confirm)', res.status === 200 && st.status === 'RESERVED', JSON.stringify(st));

  // ---------- S5 QUOTA_FULL during repair (job B has one seat)
  const app4 = await seedApp(jobB.id, 'HR_ACCEPTED', { quotaReserved: true });
  await jobCall(jobB.id, 'reserve', { application_id: app4.id });
  await jobCall(jobB.id, 'release', { application_id: app4.id, reason: 'TRANSITION_FAILED' });
  const squatter = randomUUID();
  res = await jobCall(jobB.id, 'reserve', { application_id: squatter });
  st = await jobState(jobB.id, app4.id);
  check('S5 เตรียม: ที่นั่งเดียวของ Job B ถูกคนอื่นจอง ส่วน app4 เป็น RELEASED', res.status === 200 && st.status === 'RELEASED' && st.reserved === 1, JSON.stringify(st));

  console.log('... รอ Scheduler ของ Lifecycle (รอบ 1 นาที) ซ่อมโควตา');
  await until(async () => (await jobState(jobA.id, app1.id)).status === 'RESERVED', 'repair app1');
  st = await jobState(jobA.id, app1.id);
  check('S3 repair: Job จองใหม่ให้ app1 (RESERVED) และโควตา reserved กลับเป็น 2 + app3 ถูก confirm ภายหลัง', st.status === 'RESERVED', JSON.stringify(st));
  await until(async () => (await jobState(jobA.id, app3.id)).status === 'CONFIRMED', 'repair app3');
  st = await jobState(jobA.id, app3.id);
  const jobAfter = await jobDb.job.findUniqueOrThrow({ where: { id: jobA.id } });
  check('S4 repair: QIR-03 app3 RESERVED → CONFIRMED', st.status === 'CONFIRMED', JSON.stringify(st));
  check('S4 ตัวนับของ Job A ถูกต้อง (reserved=2: app1,app2 • confirmed=1: app3)', jobAfter.quotaReserved === 2 && jobAfter.quotaConfirmed === 1, `reserved=${jobAfter.quotaReserved} confirmed=${jobAfter.quotaConfirmed}`);
  st = await jobState(jobB.id, app4.id);
  row = await lcDb.application.findUniqueOrThrow({ where: { id: app4.id } });
  check('S5 repair เจอ QUOTA_FULL ⇒ ไม่จองทับ ไม่ทำเป็นสำเร็จ และ Lifecycle ไม่เปลี่ยน', st.status === 'RELEASED' && row.quotaReserved === true && row.status === 'HR_ACCEPTED', JSON.stringify({ job: st, lc: row.status }));

  // free the seat -> next tick repairs app4
  await jobCall(jobB.id, 'release', { application_id: squatter, reason: 'XS_TEST' });
  console.log('... คืนที่นั่งของ Job B แล้วรอรอบถัดไป');
  await until(async () => (await jobState(jobB.id, app4.id)).status === 'RESERVED', 'repair app4 after seat freed');
  st = await jobState(jobB.id, app4.id);
  check('S5 มีที่ว่างแล้ว ⇒ รอบถัดไปซ่อม app4 สำเร็จ (RESERVED, reserved=1)', st.status === 'RESERVED' && st.reserved === 1, JSON.stringify(st));

  // lifecycle log should mention QUOTA_FULL warning at least once
  const lcLog = fs.readFileSync(path.join(LOGDIR, 'xs-lifecycle.log'), 'utf8');
  check('S5 Lifecycle log เตือน repair ที่ไม่สำเร็จ (QUOTA_FULL)', /CRITICAL quota inconsistency/.test(lcLog));


  // ---------- S6 JR regression over real HTTP: Job reservation already RELEASED when HR starts -> inline repair (no scheduler wait)
  const todayStr = new Date().toISOString().slice(0, 10);
  const hrStart = (id) =>
    fetch(`http://127.0.0.1:3004/v1/hr/applications/${id}/actions/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${hrToken}` },
      body: JSON.stringify({ actual_start_date: todayStr, end_date: '2027-03-30' }),
    });
  const app6 = await seedApp(jobA.id, 'ADVISOR_APPROVED', { quotaReserved: true, startDate: new Date('2027-01-10'), endDate: new Date('2027-03-30') });
  await jobCall(jobA.id, 'reserve', { application_id: app6.id });
  await jobCall(jobA.id, 'release', { application_id: app6.id, reason: 'TRANSITION_FAILED' });
  st = await jobState(jobA.id, app6.id);
  check('S6 เตรียม: Job เป็น RELEASED ก่อน HR กดเริ่มงาน', st.status === 'RELEASED', JSON.stringify(st));
  res = await hrStart(app6.id);
  row = await lcDb.application.findUniqueOrThrow({ where: { id: app6.id } });
  st = await jobState(jobA.id, app6.id);
  check('S6 start ⇒ 200 IN_PROGRESS และ Job เป็น CONFIRMED ทันที (ซ่อมทันที ไม่รอ Scheduler)', res.status === 200 && row.status === 'IN_PROGRESS' && st.status === 'CONFIRMED', JSON.stringify({ http: res.status, lc: row.status, job: st }));

  // ---------- S7 JR regression: TERMINATED before repair (state after start, Job RELEASED)
  const app7 = await seedApp(jobA.id, 'TERMINATED', { quotaReserved: true, statusChangedAt: new Date(Date.now() - 2 * 3600e3) });
  await jobCall(jobA.id, 'reserve', { application_id: app7.id });
  await jobCall(jobA.id, 'release', { application_id: app7.id, reason: 'TRANSITION_FAILED' });
  st = await jobState(jobA.id, app7.id);
  check('S7 เตรียม: ใบ TERMINATED ที่ Lifecycle ยังถือที่นั่ง แต่ Job เป็น RELEASED', st.status === 'RELEASED', JSON.stringify(st));

  // ---------- S8 QUOTA_FULL on the immediate repair (seat taken by someone else first)
  const app8 = await seedApp(jobC.id, 'ADVISOR_APPROVED', { quotaReserved: true, startDate: new Date('2027-01-10'), endDate: new Date('2027-03-30') });
  await jobCall(jobC.id, 'reserve', { application_id: app8.id });
  await jobCall(jobC.id, 'release', { application_id: app8.id, reason: 'TRANSITION_FAILED' });
  const squatter2 = randomUUID();
  await jobCall(jobC.id, 'reserve', { application_id: squatter2 });
  res = await hrStart(app8.id);
  row = await lcDb.application.findUniqueOrThrow({ where: { id: app8.id } });
  st = await jobState(jobC.id, app8.id);
  check('S8 ที่นั่งถูกคนอื่นจองไปก่อน: start ยังสำเร็จ (IN_PROGRESS) แต่ Job ยัง RELEASED (ไม่จองทับ)', res.status === 200 && row.status === 'IN_PROGRESS' && st.status === 'RELEASED', JSON.stringify({ http: res.status, lc: row.status, job: st }));
  const lcLog2 = fs.readFileSync(path.join(LOGDIR, 'xs-lifecycle.log'), 'utf8');
  check('S8 Lifecycle log error "Quota over-allocation" ทันที', /CRITICAL quota inconsistency/.test(lcLog2));

  console.log('... รอ Scheduler รอบถัดไปซ่อม app7 (TERMINATED)');
  await until(async () => (await jobState(jobA.id, app7.id)).status === 'CONFIRMED', 'repair app7 terminated');
  row = await lcDb.application.findUniqueOrThrow({ where: { id: app7.id } });
  st = await jobState(jobA.id, app7.id);
  check('S7 repair ครอบ TERMINATED ⇒ Job เป็น CONFIRMED และจด quota_synced_at', st.status === 'CONFIRMED' && row.quotaSyncedAt !== null, JSON.stringify({ job: st, synced: !!row.quotaSyncedAt }));
  st = await jobState(jobC.id, app8.id);
  check('S8 รอบ repair ขณะยังเต็ม: ยัง RELEASED และ Lifecycle ยังถือ (ไม่หลอกตัวเอง)', st.status === 'RELEASED', JSON.stringify(st));
  await jobCall(jobC.id, 'release', { application_id: squatter2, reason: 'XS_TEST' });
  console.log('... คืนที่นั่งของ Job C แล้วรอรอบถัดไป');
  await until(async () => (await jobState(jobC.id, app8.id)).status === 'CONFIRMED', 'repair app8 after seat freed');
  st = await jobState(jobC.id, app8.id);
  check('S8 มีที่ว่างแล้ว ⇒ รอบถัดไปซ่อม app8 เป็น CONFIRMED', st.status === 'CONFIRMED', JSON.stringify(st));

  await jobDb.$disconnect();
  await lcDb.$disconnect();
  await admin.end();
}

async function cleanup() {
  for (const c of children) try { c.kill(); } catch {}
  await sleep(2000);
  if (process.platform === 'win32') {
    for (const c of children) try { execFileSync('taskkill', ['/PID', String(c.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {}
  }
  const admin = new Client({ connectionString: ADMIN });
  try {
    await admin.connect();
    for (const db of [JOB_DB, LC_DB]) await admin.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
    console.log('dropped test databases');
    try { execFileSync('docker', ['exec', RABBIT_CONTAINER, 'rabbitmqctl', 'delete_vhost', VHOST], { stdio: 'ignore' }); console.log('deleted rabbitmq vhost'); } catch (e) { console.log('vhost cleanup error'); }
  } catch (e) { console.log('cleanup db error:', e.message); } finally { await admin.end().catch(() => {}); }
}

main()
  .catch((e) => { console.log('SCRIPT ERROR:', e.message); results.push({ name: 'script', ok: false }); })
  .finally(async () => {
    await cleanup();
    const failed = results.filter((r) => !r.ok).length;
    console.log(`\nRESULT: ${results.length - failed}/${results.length} passed${failed ? `, ${failed} FAILED` : ''}`);
    process.exit(failed ? 1 : 0);
  });
