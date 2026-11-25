import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

export const root = fileURLToPath(new URL('../../', import.meta.url));
const services = ['identity', 'job', 'verification', 'lifecycle', 'notification'];
const runtime = join(root, '.internpath-demo');
const manifestPath = join(runtime, 'manifest.json');
const loopback = new Set(['localhost', '127.0.0.1', '[::1]']);
const origins = { GATEWAY_URL: 3000, IDENTITY_URL: 3001, JOB_URL: 3002, VERIFICATION_URL: 3003,
  LIFECYCLE_URL: 3004, NOTIFICATION_URL: 3005, WEB_BASE_URL: 3100, DEMO_MAILPIT_URL: 8025 };
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export class DemoError extends Error {}
export function check(condition, message) {
  if (!condition) throw new DemoError(message);
}

function localUrl(value, key, protocols, { originOnly = false } = {}) {
  let url;
  try { url = new URL(value); } catch { throw new DemoError(`${key} must be a valid local URL.`); }
  check(protocols.includes(url.protocol) && loopback.has(url.hostname), `${key} must point to loopback.`);
  if (url.protocol.startsWith('http')) {
    check(!url.username && !url.password && !url.hash, `${key} must not contain credentials or a fragment.`);
    if (originOnly) check(url.pathname === '/' && !url.search, `${key} must be an origin without a path or query.`);
  }
  return url;
}

export function settings() {
  const read = path => existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const base = read(join(root, '.env'));
  const overlayPath = join(root, '.env.internpath-current');
  const overlay = read(overlayPath);
  const common = { ...base, ...process.env, ...overlay };
  check(common.DEMO_ENABLED === '1', 'Set DEMO_ENABLED=1 for a dedicated local demo stack.');
  const password = common.DEMO_PASSWORD;
  // eslint-disable-next-line no-control-regex -- Reject control characters from local demo credentials.
  check(typeof password === 'string' && password.length >= 12 && password.trim() === password && !/[\u0000-\u001f\u007f]/u.test(password),
    'Set DEMO_PASSWORD to at least 12 characters, without surrounding whitespace or control characters.');

  const envs = Object.fromEntries([...services, 'gateway', 'web'].map(name =>
    [name, { ...base, ...read(join(root, 'apps', name, '.env')), ...process.env, ...overlay }]));
  const globalPort = common.POSTGRES_PORT || '5432';
  const keys = new Set();
  const target = {};
  const effective = { ...common };
  for (const name of services) {
    const prefix = name.toUpperCase();
    const settings = envs[name];
    const targets = ['DATABASE_URL', 'DIRECT_URL'].map(suffix => {
      const key = `${prefix}_${suffix}`;
      if (existsSync(overlayPath)) check(overlay[key], `Set ${key} in .env.internpath-current, as required by dev:migrate.`);
      const url = localUrl(settings[key], key, ['postgres:', 'postgresql:']);
      const db = decodeURIComponent(url.pathname.slice(1));
      check(/^[a-z][a-z0-9_]*$/u.test(db) && !['postgres', 'template0', 'template1'].includes(db) &&
        (url.port || '5432') === globalPort && !url.hash && [...url.searchParams].every(([k,v]) => k === 'schema' && v === 'public'),
        `${key} must use a local service database on POSTGRES_PORT with the public schema and no extra connection options.`);
      effective[key] = url.href;
      return db;
    });
    check(targets[0] === targets[1] && !keys.has(targets[0]), `Check that ${prefix} uses its own matching database and direct URLs.`);
    keys.add(targets[0]);
    target[name] = targets[0];
  }
  for (const config of [common, ...Object.values(envs)]) {
    check(process.env.NODE_ENV !== 'production' && config.NODE_ENV !== 'production', 'Demo commands are disabled in production mode.');
    for (const key of Object.keys(origins)) {
      if (config[key]) localUrl(config[key], key, ['http:', 'https:'], { originOnly: true });
    }
    localUrl(config.RABBITMQ_URL, 'RABBITMQ_URL', ['amqp:', 'amqps:']);
    localUrl(config.S3_ENDPOINT, 'S3_ENDPOINT', ['http:', 'https:'], { originOnly: true });
    if (config.S3_PUBLIC_BASE_URL) localUrl(config.S3_PUBLIC_BASE_URL, 'S3_PUBLIC_BASE_URL', ['http:', 'https:']);
    if (config.NEXT_PUBLIC_API_BASE_URL && config.NEXT_PUBLIC_API_BASE_URL !== '/api/v1') {
      localUrl(config.NEXT_PUBLIC_API_BASE_URL, 'NEXT_PUBLIC_API_BASE_URL', ['http:', 'https:']);
    }
    check(loopback.has(config.SMTP_HOST) && !config.SMTP_USER && !config.SMTP_PASSWORD,
      'Configure unauthenticated loopback SMTP with local Mailpit.');
    const smtpPort = Number(config.SMTP_PORT || 1025);
    check(Number.isInteger(smtpPort) && smtpPort > 0 && smtpPort < 65536 && smtpPort !== 465, 'Configure a local Mailpit SMTP port.');
  }

  const result = { ...effective, DEMO_PASSWORD: password };
  for (const [key, port] of Object.entries(origins)) result[key] = localUrl(common[key] || `http://localhost:${port}`, key, ['http:', 'https:'], { originOnly: true }).origin;
  for (const [name, config] of Object.entries(envs)) {
    for (const [key, port] of Object.entries(origins)) {
      const origin = new URL(config[key] || `http://localhost:${port}`).origin;
      check(origin === result[key], `Ambiguous ${key} in ${name}. Use one endpoint configuration for the local stack.`);
    }
    check(['S3_ENDPOINT', 'S3_PUBLIC_BASE_URL', 'S3_BUCKET_PUBLIC', 'S3_BUCKET_PRIVATE',
      'S3_REGION', 'S3_ACCESS_KEY', 'S3_SECRET_KEY'].every(key => config[key] === common[key]) &&
      config.RABBITMQ_URL === common.RABBITMQ_URL && config.SMTP_HOST === common.SMTP_HOST &&
      Number(config.SMTP_PORT || 1025) === Number(common.SMTP_PORT || 1025),
      `Ambiguous storage, broker or SMTP configuration in ${name}.`);
  }
  const quotaSecret = envs.lifecycle.JOB_SERVICE_SECRET_LIFECYCLE;
  check(quotaSecret?.length >= 32 && quotaSecret === envs.job.JOB_SERVICE_SECRET_LIFECYCLE,
    'Set the same JOB_SERVICE_SECRET_LIFECYCLE for Lifecycle and Job.');
  result.JOB_SERVICE_SECRET_LIFECYCLE = quotaSecret;
  return { env: result, target: sha256(JSON.stringify({ port: globalPort, target })) };
}

export async function poll(label, probe, timeout = 30_000) {
  const cutoff = Date.now() + timeout;
  do {
    const result = await probe();
    if (result) return result;
    await delay(300);
  } while (Date.now() < cutoff);
  throw new DemoError(`Timed out waiting for ${label}.`);
}

export async function request(url, { method = 'GET', body, token, expect = [200], binary = false } = {}) {
  const multipart = body instanceof globalThis.FormData;
  const response = await fetch(url, {
    method, redirect: 'error', signal: AbortSignal.timeout(30_000),
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body && !multipart ? { 'Content-Type': 'application/json' } : {}) },
    body: multipart ? body : body ? JSON.stringify(body) : undefined,
  }).catch(() => { throw new DemoError(`${method} ${new URL(url).pathname} did not reach the local service.`); });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!expect.includes(response.status)) {
    let code;
    try { code = JSON.parse(bytes.toString()).error?.code; } catch { /* No JSON error envelope. */ }
    const message = `${method} ${new URL(url).pathname}: HTTP ${response.status}${/^[A-Z_]+$/u.test(code) ? ` ${code}` : ''}.`;
    throw Object.assign(new DemoError(message), { status: response.status });
  }
  if (binary) return bytes;
  return bytes.length ? JSON.parse(bytes.toString()) : undefined;
}

function smtpIsMailpit(env) {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: env.SMTP_HOST.replace(/^\[|\]$/gu, ''), port: Number(env.SMTP_PORT || 1025) });
    const fail = () => { socket.destroy(); reject(new DemoError('SMTP must be the local Mailpit listener.')); };
    let text = '';
    socket.setTimeout(3000, fail);
    socket.once('error', fail);
    socket.on('data', chunk => {
      text += chunk.toString();
      if (text.includes('\n')) {
        if (!/^220 .*Mailpit/iu.test(text)) return fail();
        socket.destroy();
        resolve();
      }
    });
    socket.once('end', fail);
  });
}

function dbClients(env) {
  return Object.fromEntries(services.map(name => {
    const { PrismaClient } = createRequire(join(root, 'apps', name, 'package.json'))('./generated/client');
    return [name, new PrismaClient({ datasourceUrl: env[`${name.toUpperCase()}_DATABASE_URL`] })];
  }));
}

async function checkBuckets(env) {
  check(env.S3_ACCESS_KEY && env.S3_SECRET_KEY, 'Set the local RustFS credentials.');
  const { S3Client, HeadBucketCommand } = createRequire(join(root, 'apps', 'lifecycle', 'package.json'))('@aws-sdk/client-s3');
  const s3 = new S3Client({ endpoint: env.S3_ENDPOINT, region: env.S3_REGION || 'auto',
    forcePathStyle: true, maxAttempts: 1, credentials: { accessKeyId: env.S3_ACCESS_KEY, secretAccessKey: env.S3_SECRET_KEY } });
  const buckets = [env.S3_BUCKET_PUBLIC || 'internpath-public', env.S3_BUCKET_PRIVATE || 'internpath-private'];
  try {
    check(buckets[0] !== buckets[1], 'Configure different local public and private buckets.');
    await Promise.all(buckets.map(Bucket => s3.send(new HeadBucketCommand({ Bucket }), {
      abortSignal: AbortSignal.timeout(5000),
    })));
  } catch {
    throw new DemoError('Local storage buckets are unavailable. Check RustFS and run pnpm infra:init-buckets.');
  } finally {
    s3.destroy();
  }
}

export async function runDemo(mode, action) {
  const config = settings(); // Validate every destination before opening connections or writing a manifest.
  const { env } = config;
  await Promise.all([
    ...[...services, 'gateway'].map(name => request(`${env[`${name.toUpperCase()}_URL`]}/ready`)),
    request(`${env.DEMO_MAILPIT_URL}/api/v1/info`),
    smtpIsMailpit(env),
    checkBuckets(env),
  ]);

  let unlock = () => {};
  let db;
  try {
    if (mode === 'seed') {
      mkdirSync(runtime, { recursive: true, mode: 0o700 });
      const path = join(runtime, 'seed.lock');
      try { writeFileSync(path, `${process.pid}\n`, { flag: 'wx', mode: 0o600 }); }
      catch { throw new DemoError('A seed is running, or .internpath-demo/seed.lock needs inspection after an interrupted run.'); }
      unlock = () => unlinkSync(path);
    }
    check(mode === 'seed' || existsSync(manifestPath), 'Demo manifest not found. Run pnpm demo:seed first.');
    const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) :
      { version: 1, target: config.target, entries: {}, packs: {} };
    check(manifest.version === 1 && manifest.target === config.target, 'The manifest belongs to a different demo database configuration.');
    const save = () => {
      check(mode === 'seed', 'Verification cannot update the demo manifest.');
      const temporary = manifestPath + '.new';
      writeFileSync(temporary, JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
      renameSync(temporary, manifestPath);
    };
    db = dbClients(env);
    await action({ env, db, manifest, save, ...clients(env) });
  } finally {
    try { await Promise.all(Object.values(db ?? {}).map(client => client.$disconnect())); }
    finally { unlock(); }
  }
}

function clients(env) {
  const api = (path, options) => request(`${env.GATEWAY_URL}/api/v1${path}`, options);
  const identity = (path, options) => request(`${env.IDENTITY_URL}/v1${path}`, options);
  const login = async (email, role, id) => {
    const response = await identity('/auth/login', { method: 'POST', body: { email, password: env.DEMO_PASSWORD } });
    check(response.user.role === role && response.user.id === id, 'Login does not match the owned demo identity.');
    return response.access_token;
  };
  const mailToken = (email, pathname) => poll(`local Mailpit link for ${email}`, async () => {
    const { messages } = await request(`${env.DEMO_MAILPIT_URL}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`);
    for (const item of messages ?? []) {
      if (!item.To?.some(to => to.Address.toLowerCase() === email.toLowerCase())) continue;
      const message = await request(`${env.DEMO_MAILPIT_URL}/api/v1/message/${encodeURIComponent(item.ID)}`);
      for (const raw of message.Text?.match(/https?:\/\/[^\s<]+/gu) ?? []) {
        const url = new URL(raw);
        if (url.origin === env.WEB_BASE_URL && url.pathname === pathname && url.searchParams.has('token')) return url.searchParams.get('token');
      }
    }
  });
  const storage = (url, { signed = true } = {}) => {
    const link = localUrl(url, 'Storage download', ['http:', 'https:']);
    const allowed = [new URL(env.S3_ENDPOINT).origin];
    if (!signed && env.S3_PUBLIC_BASE_URL) allowed.push(new URL(env.S3_PUBLIC_BASE_URL).origin);
    check(allowed.includes(link.origin), 'Download URL does not match the configured local storage.');
    return request(link.href, { binary: true });
  };
  const seedAdmin = email => {
    const child = spawnSync(process.execPath, [join(root, 'scripts', 'dev-seed-admin.cjs')], {
      cwd: root, env: { ...env, ADMIN_EMAIL: email, ADMIN_PASSWORD: env.DEMO_PASSWORD }, stdio: 'ignore', windowsHide: true,
    });
    check(child.status === 0, 'Existing Admin seed failed. Check the local Identity schema and configuration.');
  };
  const quota = (jobId, applicationId, action) => {
    const { signServiceToken } = createRequire(join(root, 'apps', 'lifecycle', 'package.json'))('@internpath/common');
    const token = signServiceToken({ issuer: 'lifecycle', audience: 'job', secret: env.JOB_SERVICE_SECRET_LIFECYCLE });
    return request(`${env.JOB_URL}/internal/v1/jobs/${jobId}/quota/${action}`,
      { method: 'POST', body: { application_id: applicationId }, token, expect: [200, 204] });
  };
  return { api, identity, login, mailToken, storage, seedAdmin, quota };
}

export async function cli(mode, action) {
  try { await runDemo(mode, action); }
  catch (error) {
    console.error(`demo:${mode}: ${error instanceof DemoError ? error.message : `Unexpected failure (${error.code ?? error.name}). Check local service logs.`}`);
    process.exitCode = 1;
  }
}
